import type { Response } from "express";
import type { RowDataPacket, ResultSetHeader } from "mysql2";
import { pool } from "../db";
import type { AuthedRequest } from "../middleware/auth";

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function toMoney(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? round2(value) : null;
  if (typeof value === "string" && /^\d+(\.\d{1,2})?$/.test(value.trim())) return Number(value.trim());
  return null;
}

function monthBounds(year: number, month: number): { first: string; last: string } {
  const p = (n: number) => String(n).padStart(2, "0");
  const lastDay = new Date(year, month, 0).getDate();
  return { first: `${year}-${p(month)}-01`, last: `${year}-${p(month)}-${p(lastDay)}` };
}

const dateOnly = (v: unknown) => String(v).slice(0, 10);

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function stop(status: number, message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

// Works out the visits, members and amount for one agreement and month
async function calculate(
  agreementId: number,
  year: number,
  month: number
): Promise<{ visits: number; members: number; amount: number; pending: number; agreement: RowDataPacket }> {
  const [agr] = await pool.query<RowDataPacket[]>(
    "SELECT * FROM facility_agreements WHERE agreement_id = ?",
    [agreementId]
  );
  if (!agr[0]) throw stop(404, "Agreement not found.");
  if (agr[0].status === "Draft") throw stop(400, "A draft agreement cannot be billed. Activate it first.");

  const { first, last } = monthBounds(year, month);
  const start = dateOnly(agr[0].start_date);
  const end = dateOnly(agr[0].end_date);
  if (start > last || end < first) throw stop(400, "The agreement was not in force during that month.");

  const [v] = await pool.query<RowDataPacket[]>(
    `SELECT SUM(status = 'Confirmed') AS confirmed, SUM(status = 'Pending') AS pending
     FROM facility_visits
     WHERE agreement_id = ? AND visit_date >= ? AND visit_date <= ?`,
    [agreementId, first, last]
  );
  const visits = Number(v[0].confirmed ?? 0);
  const pending = Number(v[0].pending ?? 0);

  // Members on the last day the agreement applied in that month
  const countDay = end < last ? end : last;
  const [m] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM facility_enrollments
     WHERE facility_id = ? AND start_date <= ? AND (end_date IS NULL OR end_date >= ?)
       AND status <> 'Suspended'`,
    [agr[0].facility_id, countDay, countDay]
  );
  const members = Number(m[0].n);

  const rate = Number(agr[0].rate);
  let amount = 0;
  if (agr[0].billing_model === "Monthly flat fee") amount = rate;
  else if (agr[0].billing_model === "Per visit") amount = rate * visits;
  else amount = rate * members;

  return { visits, members, amount: round2(amount), pending, agreement: agr[0] };
}

const STATEMENT_SELECT = `s.statement_id, s.agreement_id, s.period_year, s.period_month,
       s.visits_count, s.members_count, s.amount, s.provider_reference, s.invoiced_amount,
       s.status, s.approved_at, s.paid_at,
       f.facility_id, f.name AS facility_name, f.facility_type,
       a.billing_model, a.rate,
       ab.full_name AS approved_by_name, pb.full_name AS paid_by_name`;

const STATEMENT_JOINS = `FROM facility_statements s
       JOIN facility_agreements a ON a.agreement_id = s.agreement_id
       JOIN facilities f ON f.facility_id = a.facility_id
       LEFT JOIN users ab ON ab.user_id = s.approved_by
       LEFT JOIN users pb ON pb.user_id = s.paid_by`;

function shape(r: RowDataPacket) {
  const amount = Number(r.amount);
  const invoiced = r.invoiced_amount === null ? null : Number(r.invoiced_amount);
  return {
    ...r,
    rate: Number(r.rate),
    amount,
    invoiced_amount: invoiced,
    difference: invoiced === null ? null : round2(invoiced - amount),
  };
}

export async function listStatements(req: AuthedRequest, res: Response): Promise<void> {
  const year = parseInt(asText(req.query.year), 10) || null;
  const month = parseInt(asText(req.query.month), 10) || null;
  const status = asText(req.query.status);
  const facilityId = parseInt(asText(req.query.facility_id), 10) || null;

  try {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (year) {
      where.push("s.period_year = ?");
      params.push(year);
    }
    if (month) {
      where.push("s.period_month = ?");
      params.push(month);
    }
    if (["Draft", "Approved", "Paid"].includes(status)) {
      where.push("s.status = ?");
      params.push(status);
    }
    if (facilityId) {
      where.push("f.facility_id = ?");
      params.push(facilityId);
    }
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT ${STATEMENT_SELECT} ${STATEMENT_JOINS}
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY s.period_year DESC, s.period_month DESC, f.name`,
      params
    );
    res.json({ data: rows.map(shape) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function getStatement(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  if (!id) {
    res.status(400).json({ message: "Invalid statement id." });
    return;
  }
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT ${STATEMENT_SELECT} ${STATEMENT_JOINS} WHERE s.statement_id = ?`,
      [id]
    );
    if (!rows[0]) {
      res.status(404).json({ message: "Statement not found." });
      return;
    }
    const s = rows[0];
    const { first, last } = monthBounds(Number(s.period_year), Number(s.period_month));

    // The visits behind the amount, so HR can check it against the provider's sheet
    const [visits] = await pool.query<RowDataPacket[]>(
      `SELECT v.visit_id, v.visit_date, v.status, v.source, e.full_name, e.employee_code
       FROM facility_visits v JOIN employees e ON e.employee_id = v.employee_id
       WHERE v.agreement_id = ? AND v.visit_date >= ? AND v.visit_date <= ?
       ORDER BY v.visit_date, e.full_name`,
      [s.agreement_id, first, last]
    );
    const [pending] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM facility_visits
       WHERE agreement_id = ? AND visit_date >= ? AND visit_date <= ? AND status = 'Pending'`,
      [s.agreement_id, first, last]
    );

    res.json({ data: { ...shape(s), pending_visits: Number(pending[0].n), visits } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function createStatement(req: AuthedRequest, res: Response): Promise<void> {
  const agreementId = parseInt(asText(String(req.body?.agreementId ?? "")), 10);
  const year = Number(req.body?.year);
  const month = Number(req.body?.month);
  const now = new Date();

  if (!agreementId) {
    res.status(400).json({ message: "Choose an agreement." });
    return;
  }
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    res.status(400).json({ message: "Enter a valid year." });
    return;
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    res.status(400).json({ message: "The month must be from 1 to 12." });
    return;
  }
  if (year * 12 + month > now.getFullYear() * 12 + (now.getMonth() + 1)) {
    res.status(400).json({ message: "You cannot bill a future month." });
    return;
  }

  try {
    const result = await calculate(agreementId, year, month);
    const [r] = await pool.query<ResultSetHeader>(
      `INSERT INTO facility_statements
         (agreement_id, period_year, period_month, visits_count, members_count, amount, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [agreementId, year, month, result.visits, result.members, result.amount, req.user?.userId ?? null]
    );
    res.status(201).json({
      message: `Statement created for ${MONTH_NAMES[month - 1]} ${year}.`,
      statement_id: r.insertId,
      amount: result.amount,
      pending_visits: result.pending,
    });
  } catch (err) {
    const known = (err as { status?: unknown }).status;
    if (typeof known === "number") {
      res.status(known).json({ message: (err as Error).message });
      return;
    }
    const e = err as { code?: string };
    if (e.code === "ER_DUP_ENTRY") {
      res.status(409).json({ message: "A statement for this agreement and month already exists." });
    } else {
      console.error(err);
      res.status(500).json({ message: "Database error" });
    }
  }
}

export async function recalculateStatement(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  if (!id) {
    res.status(400).json({ message: "Invalid statement id." });
    return;
  }
  try {
    const [found] = await pool.query<RowDataPacket[]>(
      "SELECT agreement_id, period_year, period_month, status FROM facility_statements WHERE statement_id = ?",
      [id]
    );
    if (!found[0]) {
      res.status(404).json({ message: "Statement not found." });
      return;
    }
    if (found[0].status !== "Draft") {
      res.status(400).json({ message: "An approved statement cannot be recalculated." });
      return;
    }
    const result = await calculate(found[0].agreement_id, Number(found[0].period_year), Number(found[0].period_month));
    await pool.query(
      "UPDATE facility_statements SET visits_count = ?, members_count = ?, amount = ? WHERE statement_id = ? AND status = 'Draft'",
      [result.visits, result.members, result.amount, id]
    );
    res.json({ message: "Statement recalculated.", amount: result.amount, pending_visits: result.pending });
  } catch (err) {
    const known = (err as { status?: unknown }).status;
    if (typeof known === "number") {
      res.status(known).json({ message: (err as Error).message });
      return;
    }
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

// HR notes the provider's invoice so the difference is visible. Allowed until the statement is paid.
export async function recordInvoice(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  const reference = asText(req.body?.providerReference) || null;
  const hasAmount = req.body?.invoicedAmount !== undefined && req.body?.invoicedAmount !== null && req.body?.invoicedAmount !== "";
  const invoiced = hasAmount ? toMoney(req.body.invoicedAmount) : null;

  if (!id) {
    res.status(400).json({ message: "Invalid statement id." });
    return;
  }
  if (reference && reference.length > 100) {
    res.status(400).json({ message: "The reference must be 100 characters or fewer." });
    return;
  }
  if (hasAmount && (invoiced === null || invoiced < 0)) {
    res.status(400).json({ message: "The invoiced amount must be a number of 0 or more." });
    return;
  }

  try {
    const [found] = await pool.query<RowDataPacket[]>(
      "SELECT status FROM facility_statements WHERE statement_id = ?",
      [id]
    );
    if (!found[0]) {
      res.status(404).json({ message: "Statement not found." });
      return;
    }
    if (found[0].status === "Paid") {
      res.status(400).json({ message: "A paid statement cannot be changed." });
      return;
    }
    await pool.query(
      "UPDATE facility_statements SET provider_reference = ?, invoiced_amount = ? WHERE statement_id = ?",
      [reference, invoiced, id]
    );
    res.json({ message: "Invoice details saved." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function approveStatement(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  if (!id) {
    res.status(400).json({ message: "Invalid statement id." });
    return;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [found] = await conn.query<RowDataPacket[]>(
      "SELECT agreement_id, period_year, period_month, status FROM facility_statements WHERE statement_id = ? FOR UPDATE",
      [id]
    );
    const cur = found[0];
    if (!cur) throw stop(404, "Statement not found.");
    if (cur.status !== "Draft") throw stop(409, `This statement is already ${cur.status.toLowerCase()}.`);

    // Recalculate at the moment of approval, so the locked figure is always current
    const result = await calculate(cur.agreement_id, Number(cur.period_year), Number(cur.period_month));
    if (result.pending > 0) {
      throw stop(
        400,
        `${result.pending} visit(s) are still waiting for review. Confirm or reject them before approving.`
      );
    }

    await conn.query(
      `UPDATE facility_statements
       SET visits_count = ?, members_count = ?, amount = ?, status = 'Approved', approved_by = ?, approved_at = NOW()
       WHERE statement_id = ?`,
      [result.visits, result.members, result.amount, req.user?.userId ?? null, id]
    );
    await conn.commit();
    res.json({ message: "Statement approved and locked.", amount: result.amount });
  } catch (err) {
    await conn.rollback();
    const known = (err as { status?: unknown }).status;
    if (typeof known === "number") {
      res.status(known).json({ message: (err as Error).message });
    } else {
      console.error(err);
      res.status(500).json({ message: "Database error" });
    }
  } finally {
    conn.release();
  }
}

export async function markStatementPaid(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  if (!id) {
    res.status(400).json({ message: "Invalid statement id." });
    return;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [found] = await conn.query<RowDataPacket[]>(
      "SELECT status FROM facility_statements WHERE statement_id = ? FOR UPDATE",
      [id]
    );
    if (!found[0]) throw stop(404, "Statement not found.");
    if (found[0].status === "Paid") throw stop(409, "This statement is already marked as paid.");
    if (found[0].status !== "Approved") throw stop(400, "Only an approved statement can be marked as paid.");

    await conn.query(
      "UPDATE facility_statements SET status = 'Paid', paid_by = ?, paid_at = NOW() WHERE statement_id = ?",
      [req.user?.userId ?? null, id]
    );
    await conn.commit();
    res.json({ message: "Statement marked as paid." });
  } catch (err) {
    await conn.rollback();
    const known = (err as { status?: unknown }).status;
    if (typeof known === "number") {
      res.status(known).json({ message: (err as Error).message });
    } else {
      console.error(err);
      res.status(500).json({ message: "Database error" });
    }
  } finally {
    conn.release();
  }
}

export async function deleteStatement(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  if (!id) {
    res.status(400).json({ message: "Invalid statement id." });
    return;
  }
  try {
    const [found] = await pool.query<RowDataPacket[]>(
      "SELECT status FROM facility_statements WHERE statement_id = ?",
      [id]
    );
    if (!found[0]) {
      res.status(404).json({ message: "Statement not found." });
      return;
    }
    if (found[0].status !== "Draft") {
      res.status(400).json({ message: "Only a draft statement can be deleted." });
      return;
    }
    await pool.query("DELETE FROM facility_statements WHERE statement_id = ? AND status = 'Draft'", [id]);
    res.json({ message: "Draft statement deleted." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

/* ---------- cost report ---------- */

export async function costReport(req: AuthedRequest, res: Response): Promise<void> {
  const year = parseInt(asText(req.query.year), 10) || new Date().getFullYear();

  try {
    // Only approved and paid statements count as cost
    const [byMonth] = await pool.query<RowDataPacket[]>(
      `SELECT period_month AS month, SUM(amount) AS cost, SUM(visits_count) AS visits
       FROM facility_statements
       WHERE period_year = ? AND status IN ('Approved','Paid')
       GROUP BY period_month ORDER BY period_month`,
      [year]
    );

    const [byFacility] = await pool.query<RowDataPacket[]>(
      `SELECT f.facility_id, f.name, f.facility_type,
              COALESCE(SUM(s.amount), 0) AS cost,
              COALESCE(SUM(s.visits_count), 0) AS visits,
              (SELECT COUNT(*) FROM facility_enrollments en
                 WHERE en.facility_id = f.facility_id AND en.status = 'Active') AS members,
              (SELECT COUNT(*) FROM facility_enrollments en
                 WHERE en.facility_id = f.facility_id AND en.status = 'Active'
                   AND NOT EXISTS (SELECT 1 FROM facility_visits v
                                   WHERE v.facility_id = en.facility_id AND v.employee_id = en.employee_id
                                     AND v.status = 'Confirmed' AND YEAR(v.visit_date) = ?)) AS never_visited
       FROM facilities f
       LEFT JOIN facility_agreements a ON a.facility_id = f.facility_id
       LEFT JOIN facility_statements s ON s.agreement_id = a.agreement_id
         AND s.period_year = ? AND s.status IN ('Approved','Paid')
       GROUP BY f.facility_id, f.name, f.facility_type
       ORDER BY cost DESC, f.name`,
      [year, year]
    );

    const months = byMonth.map((m) => {
      const cost = Number(m.cost);
      const visits = Number(m.visits);
      return {
        month: Number(m.month),
        cost,
        visits,
        cost_per_visit: visits > 0 ? round2(cost / visits) : null,
      };
    });
    const totalCost = months.reduce((sum, m) => sum + m.cost, 0);
    const totalVisits = months.reduce((sum, m) => sum + m.visits, 0);

    res.json({
      data: {
        year,
        total_cost: round2(totalCost),
        total_visits: totalVisits,
        average_cost_per_visit: totalVisits > 0 ? round2(totalCost / totalVisits) : null,
        months,
        facilities: byFacility.map((f) => {
          const cost = Number(f.cost);
          const visits = Number(f.visits);
          const members = Number(f.members);
          return {
            facility_id: f.facility_id,
            name: f.name,
            facility_type: f.facility_type,
            cost,
            visits,
            members,
            never_visited: Number(f.never_visited),
            cost_per_visit: visits > 0 ? round2(cost / visits) : null,
            cost_per_member: members > 0 ? round2(cost / members) : null,
          };
        }),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}