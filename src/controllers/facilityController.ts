import type { Response } from "express";
import type { RowDataPacket, ResultSetHeader } from "mysql2";
import { pool } from "../db";
import type { AuthedRequest } from "../middleware/auth";

const FACILITY_TYPES = ["Gym", "Swimming pool", "Sports club", "Other"];
const BILLING_MODELS = ["Monthly flat fee", "Per visit", "Per member per month"];
const AGREEMENT_STATUSES = ["Draft", "Active", "Expired", "Terminated"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isValidDate(value: string): boolean {
  return DATE_RE.test(value) && !Number.isNaN(new Date(value + "T00:00:00").getTime());
}

function todayString(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const dateOnly = (v: unknown) => String(v).slice(0, 10);

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b + "T00:00:00").getTime() - new Date(a + "T00:00:00").getTime()) / 86400000);
}

// Accepts 1500, "1500" or "1500.50"; rejects anything that is not a plain number
function toMoney(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  if (typeof value === "string" && /^\d+(\.\d{1,2})?$/.test(value.trim())) return Number(value.trim());
  return null;
}

function parseMaxVisits(value: unknown): { ok: boolean; value: number | null } {
  if (value === undefined || value === null || value === "") return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 31) return { ok: false, value: null };
  return { ok: true, value: n };
}

async function myEmployeeId(userId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT employee_id FROM users WHERE user_id = ?",
    [userId]
  );
  return rows[0]?.employee_id ?? 0;
}

// Agreements that ran past their end date become Expired
async function expireAgreements(): Promise<void> {
  await pool.query(
    "UPDATE facility_agreements SET status = 'Expired' WHERE status = 'Active' AND end_date < CURDATE()"
  );
}

const IN_FORCE_SQL = `EXISTS (SELECT 1 FROM facility_agreements ag
   WHERE ag.facility_id = f.facility_id AND ag.status = 'Active'
     AND ag.start_date <= CURDATE() AND ag.end_date >= CURDATE())`;

/* ---------- facilities ---------- */

const FACILITY_FIELDS: Record<string, { col: string; max: number; label: string }> = {
  name: { col: "name", max: 150, label: "The name" },
  facilityType: { col: "facility_type", max: 30, label: "The type" },
  ownerName: { col: "owner_name", max: 150, label: "The owner name" },
  phone: { col: "phone", max: 30, label: "The phone number" },
  email: { col: "email", max: 150, label: "The email" },
  address: { col: "address", max: 255, label: "The address" },
  openingHours: { col: "opening_hours", max: 255, label: "The opening hours" },
  accessInstructions: { col: "access_instructions", max: 500, label: "The access instructions" },
};

function parseFacility(b: Record<string, unknown>): { values: Record<string, string | null>; errors: string[] } {
  const values: Record<string, string | null> = {};
  const errors: string[] = [];

  for (const [key, def] of Object.entries(FACILITY_FIELDS)) {
    if (b[key] === undefined) continue;
    const text = asText(b[key]);
    if (!text) {
      if (key === "name") errors.push("A name is required.");
      else if (key === "facilityType") errors.push("Choose a type.");
      else values[def.col] = null;
      continue;
    }
    if (text.length > def.max) {
      errors.push(`${def.label} must be ${def.max} characters or fewer.`);
      continue;
    }
    if (key === "phone" && !/^[0-9+\-\s()]{7,30}$/.test(text)) {
      errors.push("Invalid phone number.");
      continue;
    }
    if (key === "email" && !/^\S+@\S+\.\S+$/.test(text)) {
      errors.push("Invalid email address.");
      continue;
    }
    if (key === "facilityType" && !FACILITY_TYPES.includes(text)) {
      errors.push("The type must be Gym, Swimming pool, Sports club or Other.");
      continue;
    }
    values[def.col] = text;
  }
  return { values, errors };
}

export async function listFacilities(req: AuthedRequest, res: Response): Promise<void> {
  const staff = req.user!.role === "HR" || req.user!.role === "Chief";
  const search = asText(req.query.search);
  const type = asText(req.query.type);
  const status = asText(req.query.status);

  try {
    await expireAgreements();
    const me = await myEmployeeId(req.user!.userId);

    const where: string[] = [];
    const params: (string | number)[] = [];
    if (!staff) {
      // Employees only see benefits that are really available
      where.push("f.status = 'Active'");
      where.push(IN_FORCE_SQL);
    } else if (status === "Active" || status === "Inactive") {
      where.push("f.status = ?");
      params.push(status);
    }
    if (search) {
      where.push("f.name LIKE ?");
      params.push(`%${search}%`);
    }
    if (FACILITY_TYPES.includes(type)) {
      where.push("f.facility_type = ?");
      params.push(type);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const columns = staff
      ? `f.facility_id, f.name, f.facility_type, f.owner_name, f.phone, f.email, f.address,
         f.opening_hours, f.access_instructions, f.status,
         (SELECT ag.billing_model FROM facility_agreements ag
            WHERE ag.facility_id = f.facility_id AND ag.status = 'Active'
              AND ag.start_date <= CURDATE() AND ag.end_date >= CURDATE() LIMIT 1) AS current_billing_model,
         (SELECT ag.end_date FROM facility_agreements ag
            WHERE ag.facility_id = f.facility_id AND ag.status = 'Active'
              AND ag.start_date <= CURDATE() AND ag.end_date >= CURDATE() LIMIT 1) AS current_agreement_end,
         (SELECT COUNT(*) FROM facility_enrollments en
            WHERE en.facility_id = f.facility_id AND en.status = 'Active') AS members`
      : "f.facility_id, f.name, f.facility_type, f.phone, f.address, f.opening_hours, f.access_instructions, f.status";

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT ${columns},
              (SELECT en.status FROM facility_enrollments en
                 WHERE en.facility_id = f.facility_id AND en.employee_id = ?) AS my_enrollment
       FROM facilities f
       ${whereSql}
       ORDER BY f.name`,
      [me, ...params]
    );
    res.json({ data: rows.map((r) => ({ ...r, ...(staff ? { members: Number(r.members) } : {}) })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function getFacility(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  const staff = req.user!.role === "HR" || req.user!.role === "Chief";
  if (!id) {
    res.status(400).json({ message: "Invalid facility id." });
    return;
  }

  try {
    await expireAgreements();
    const me = await myEmployeeId(req.user!.userId);

    const columns = staff
      ? "f.*"
      : "f.facility_id, f.name, f.facility_type, f.phone, f.address, f.opening_hours, f.access_instructions, f.status";
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT ${columns}, ${IN_FORCE_SQL} AS available,
              (SELECT en.status FROM facility_enrollments en
                 WHERE en.facility_id = f.facility_id AND en.employee_id = ?) AS my_enrollment
       FROM facilities f WHERE f.facility_id = ?`,
      [me, id]
    );
    const fac = rows[0];
    // The same answer whether it does not exist or is simply not available to you
    if (!fac || (!staff && (fac.status !== "Active" || !Number(fac.available)))) {
      res.status(404).json({ message: "Facility not found." });
      return;
    }

    let agreements: RowDataPacket[] = [];
    if (staff) {
      const [a] = await pool.query<RowDataPacket[]>(
        `SELECT agreement_id, billing_model, rate, max_visits_per_member_month, start_date, end_date, status
         FROM facility_agreements WHERE facility_id = ? ORDER BY start_date DESC`,
        [id]
      );
      agreements = a.map((x) => ({ ...x, rate: Number(x.rate) }));
    }

    res.json({ data: { ...fac, available: Number(fac.available) === 1, agreements } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function createFacility(req: AuthedRequest, res: Response): Promise<void> {
  const { values, errors } = parseFacility(req.body ?? {});
  if ((req.body ?? {}).name === undefined) errors.unshift("A name is required.");
  if (errors.length) {
    res.status(400).json({ message: errors[0], errors });
    return;
  }

  try {
    const cols = [...Object.keys(values), "created_by"];
    const [r] = await pool.query<ResultSetHeader>(
      `INSERT INTO facilities (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      [...Object.values(values), req.user?.userId ?? null]
    );
    res.status(201).json({ message: "Facility created", facility_id: r.insertId });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "ER_DUP_ENTRY") {
      res.status(409).json({ message: "A facility with this name already exists." });
    } else {
      console.error(err);
      res.status(500).json({ message: "Database error" });
    }
  }
}

export async function updateFacility(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  if (!id) {
    res.status(400).json({ message: "Invalid facility id." });
    return;
  }

  const { values, errors } = parseFacility(req.body ?? {});
  if (errors.length) {
    res.status(400).json({ message: errors[0], errors });
    return;
  }
  if (!Object.keys(values).length) {
    res.status(400).json({ message: "Nothing to update." });
    return;
  }

  try {
    const cols = Object.keys(values);
    const [r] = await pool.query<ResultSetHeader>(
      `UPDATE facilities SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE facility_id = ?`,
      [...Object.values(values), id]
    );
    if (!r.affectedRows) {
      res.status(404).json({ message: "Facility not found." });
      return;
    }
    res.json({ message: "Facility updated" });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "ER_DUP_ENTRY") {
      res.status(409).json({ message: "A facility with this name already exists." });
    } else {
      console.error(err);
      res.status(500).json({ message: "Database error" });
    }
  }
}

export async function changeFacilityStatus(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  const status = asText(req.body?.status);
  if (!id) {
    res.status(400).json({ message: "Invalid facility id." });
    return;
  }
  if (status !== "Active" && status !== "Inactive") {
    res.status(400).json({ message: "Status must be Active or Inactive." });
    return;
  }

  try {
    await expireAgreements();
    const [found] = await pool.query<RowDataPacket[]>(
      "SELECT status FROM facilities WHERE facility_id = ?",
      [id]
    );
    if (!found[0]) {
      res.status(404).json({ message: "Facility not found." });
      return;
    }
    if (found[0].status === status) {
      res.json({ message: "No changes", status });
      return;
    }
    if (status === "Inactive") {
      const [live] = await pool.query<RowDataPacket[]>(
        `SELECT agreement_id FROM facility_agreements
         WHERE facility_id = ? AND status = 'Active' AND end_date >= CURDATE() LIMIT 1`,
        [id]
      );
      if (live[0]) {
        res.status(400).json({
          message: "This facility has an active agreement. Terminate the agreement before deactivating it.",
        });
        return;
      }
    }
    await pool.query("UPDATE facilities SET status = ? WHERE facility_id = ?", [status, id]);
    res.json({ message: `Facility is now ${status}`, status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

/* ---------- agreements ---------- */

interface AgreementValues {
  billingModel: string;
  rate: number | null;
  maxVisits: { ok: boolean; value: number | null };
  startDate: string;
  endDate: string;
  paymentTerms: string | null;
  notes: string | null;
}

function checkAgreement(v: AgreementValues): string[] {
  const e: string[] = [];
  if (!BILLING_MODELS.includes(v.billingModel)) {
    e.push("Choose a billing model: Monthly flat fee, Per visit or Per member per month.");
  }
  if (v.rate === null || v.rate <= 0) e.push("The rate must be a number greater than 0.");
  else if (v.rate > 100000000) e.push("The rate is too large.");
  if (!v.maxVisits.ok) e.push("The monthly visit limit must be a whole number from 1 to 31, or empty.");
  if (!isValidDate(v.startDate)) e.push("The start date must be YYYY-MM-DD.");
  if (!isValidDate(v.endDate)) e.push("The end date must be YYYY-MM-DD.");
  else if (isValidDate(v.startDate)) {
    if (v.endDate < v.startDate) e.push("The end date cannot be before the start date.");
    else if (daysBetween(v.startDate, v.endDate) > 3660) e.push("An agreement cannot run for more than 10 years.");
  }
  if (v.paymentTerms && v.paymentTerms.length > 255) e.push("The payment terms must be 255 characters or fewer.");
  if (v.notes && v.notes.length > 2000) e.push("The notes must be 2000 characters or fewer.");
  return e;
}

const AGREEMENT_SELECT = `a.agreement_id, a.facility_id, f.name AS facility_name, f.facility_type,
       a.billing_model, a.rate, a.max_visits_per_member_month, a.start_date, a.end_date,
       a.payment_terms, a.notes, a.status, a.terminated_reason,
       DATEDIFF(a.end_date, CURDATE()) AS days_left`;

function shapeAgreement(r: RowDataPacket) {
  const daysLeft = Number(r.days_left);
  return {
    ...r,
    rate: Number(r.rate),
    days_left: daysLeft,
    expiring_soon: r.status === "Active" && daysLeft >= 0 && daysLeft <= 30,
  };
}

// Another active agreement for the same facility covering any of these dates
async function overlapping(facilityId: number, exceptId: number, start: string, end: string): Promise<boolean> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT agreement_id FROM facility_agreements
     WHERE facility_id = ? AND status = 'Active' AND agreement_id <> ?
       AND start_date <= ? AND end_date >= ? LIMIT 1`,
    [facilityId, exceptId, end, start]
  );
  return Boolean(rows[0]);
}

export async function listAgreements(req: AuthedRequest, res: Response): Promise<void> {
  const facilityId = parseInt(asText(req.query.facility_id), 10) || null;
  const status = asText(req.query.status);

  try {
    await expireAgreements();
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (facilityId) {
      where.push("a.facility_id = ?");
      params.push(facilityId);
    }
    if (AGREEMENT_STATUSES.includes(status)) {
      where.push("a.status = ?");
      params.push(status);
    }
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT ${AGREEMENT_SELECT}
       FROM facility_agreements a JOIN facilities f ON f.facility_id = a.facility_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY FIELD(a.status, 'Active', 'Draft', 'Expired', 'Terminated'), a.end_date`,
      params
    );
    res.json({ data: rows.map(shapeAgreement) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function listExpiring(req: AuthedRequest, res: Response): Promise<void> {
  const days = Math.min(Math.max(parseInt(asText(req.query.days), 10) || 30, 1), 365);
  try {
    await expireAgreements();
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT ${AGREEMENT_SELECT}
       FROM facility_agreements a JOIN facilities f ON f.facility_id = a.facility_id
       WHERE a.status = 'Active' AND a.end_date >= CURDATE()
         AND a.end_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)
       ORDER BY a.end_date`,
      [days]
    );
    res.json({ data: rows.map(shapeAgreement), days });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function getAgreement(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  if (!id) {
    res.status(400).json({ message: "Invalid agreement id." });
    return;
  }
  try {
    await expireAgreements();
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT ${AGREEMENT_SELECT}
       FROM facility_agreements a JOIN facilities f ON f.facility_id = a.facility_id
       WHERE a.agreement_id = ?`,
      [id]
    );
    if (!rows[0]) {
      res.status(404).json({ message: "Agreement not found." });
      return;
    }
    res.json({ data: shapeAgreement(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function createAgreement(req: AuthedRequest, res: Response): Promise<void> {
  const b = req.body ?? {};
  const facilityId = parseInt(asText(String(b.facilityId ?? "")), 10);
  const v: AgreementValues = {
    billingModel: asText(b.billingModel),
    rate: toMoney(b.rate),
    maxVisits: parseMaxVisits(b.maxVisitsPerMemberMonth),
    startDate: asText(b.startDate) || todayString(),
    endDate: asText(b.endDate),
    paymentTerms: asText(b.paymentTerms) || null,
    notes: asText(b.notes) || null,
  };

  const errors = checkAgreement(v);
  if (!facilityId) errors.unshift("Choose a facility.");
  if (errors.length) {
    res.status(400).json({ message: errors[0], errors });
    return;
  }

  try {
    const [fac] = await pool.query<RowDataPacket[]>(
      "SELECT status FROM facilities WHERE facility_id = ?",
      [facilityId]
    );
    if (!fac[0]) {
      res.status(404).json({ message: "Facility not found." });
      return;
    }
    if (fac[0].status !== "Active") {
      res.status(400).json({ message: "Agreements can only be made for an active facility." });
      return;
    }

    const [r] = await pool.query<ResultSetHeader>(
      `INSERT INTO facility_agreements
         (facility_id, billing_model, rate, max_visits_per_member_month, start_date, end_date,
          payment_terms, notes, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Draft', ?)`,
      [facilityId, v.billingModel, v.rate, v.maxVisits.value, v.startDate, v.endDate,
       v.paymentTerms, v.notes, req.user?.userId ?? null]
    );
    res.status(201).json({
      message: "Agreement saved as a draft. Activate it when it is signed.",
      agreement_id: r.insertId,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function updateAgreement(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  const b = req.body ?? {};
  if (!id) {
    res.status(400).json({ message: "Invalid agreement id." });
    return;
  }

  try {
    await expireAgreements();
    const [found] = await pool.query<RowDataPacket[]>(
      "SELECT * FROM facility_agreements WHERE agreement_id = ?",
      [id]
    );
    const cur = found[0];
    if (!cur) {
      res.status(404).json({ message: "Agreement not found." });
      return;
    }
    if (cur.status === "Expired" || cur.status === "Terminated") {
      res.status(400).json({
        message: `A${cur.status === "Expired" ? "n" : ""} ${cur.status.toLowerCase()} agreement cannot be edited. Create a new one.`,
      });
      return;
    }

    const v: AgreementValues = {
      billingModel: b.billingModel === undefined ? cur.billing_model : asText(b.billingModel),
      rate: b.rate === undefined ? Number(cur.rate) : toMoney(b.rate),
      maxVisits:
        b.maxVisitsPerMemberMonth === undefined
          ? { ok: true, value: cur.max_visits_per_member_month === null ? null : Number(cur.max_visits_per_member_month) }
          : parseMaxVisits(b.maxVisitsPerMemberMonth),
      startDate: b.startDate === undefined ? dateOnly(cur.start_date) : asText(b.startDate),
      endDate: b.endDate === undefined ? dateOnly(cur.end_date) : asText(b.endDate),
      paymentTerms: b.paymentTerms === undefined ? cur.payment_terms : asText(b.paymentTerms) || null,
      notes: b.notes === undefined ? cur.notes : asText(b.notes) || null,
    };

    const errors = checkAgreement(v);

    if (cur.status === "Active") {
      if (
        v.billingModel !== cur.billing_model ||
        v.rate !== Number(cur.rate) ||
        v.startDate !== dateOnly(cur.start_date)
      ) {
        errors.push(
          "The billing model, rate and start date of an active agreement cannot be changed. Terminate it and create a new agreement."
        );
      }
      if (isValidDate(v.endDate) && v.endDate < dateOnly(cur.end_date)) {
        errors.push("An active agreement can only be extended. To end it earlier, terminate it.");
      }
      if (
        !errors.length &&
        v.endDate > dateOnly(cur.end_date) &&
        (await overlapping(cur.facility_id, id, v.startDate, v.endDate))
      ) {
        errors.push("The longer agreement would overlap another active agreement for this facility.");
      }
    }

    if (errors.length) {
      res.status(400).json({ message: errors[0], errors });
      return;
    }

    await pool.query(
      `UPDATE facility_agreements
       SET billing_model = ?, rate = ?, max_visits_per_member_month = ?, start_date = ?, end_date = ?,
           payment_terms = ?, notes = ?
       WHERE agreement_id = ?`,
      [v.billingModel, v.rate, v.maxVisits.value, v.startDate, v.endDate, v.paymentTerms, v.notes, id]
    );
    res.json({ message: "Agreement updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function activateAgreement(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  if (!id) {
    res.status(400).json({ message: "Invalid agreement id." });
    return;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [found] = await conn.query<RowDataPacket[]>(
      `SELECT a.facility_id, a.status, a.start_date, a.end_date, f.status AS facility_status
       FROM facility_agreements a JOIN facilities f ON f.facility_id = a.facility_id
       WHERE a.agreement_id = ? FOR UPDATE`,
      [id]
    );
    const cur = found[0];
    const stop = (status: number, message: string) => Object.assign(new Error(message), { status });
    if (!cur) throw stop(404, "Agreement not found.");
    if (cur.status !== "Draft") throw stop(400, `Only a draft can be activated. This one is ${cur.status}.`);
    if (cur.facility_status !== "Active") throw stop(400, "The facility is not active.");
    if (dateOnly(cur.end_date) < todayString()) throw stop(400, "The end date has already passed.");
    if (await overlapping(cur.facility_id, id, dateOnly(cur.start_date), dateOnly(cur.end_date))) {
      throw stop(409, "Another active agreement for this facility covers some of these dates.");
    }

    await conn.query("UPDATE facility_agreements SET status = 'Active' WHERE agreement_id = ?", [id]);
    await conn.commit();
    res.json({ message: "Agreement is now active" });
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

export async function terminateAgreement(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  const reason = asText(req.body?.reason);
  if (!id) {
    res.status(400).json({ message: "Invalid agreement id." });
    return;
  }
  if (reason.length < 3) {
    res.status(400).json({ message: "Please give a reason (at least 3 characters)." });
    return;
  }
  if (reason.length > 255) {
    res.status(400).json({ message: "The reason must be 255 characters or fewer." });
    return;
  }

  try {
    await expireAgreements();
    const [found] = await pool.query<RowDataPacket[]>(
      "SELECT status FROM facility_agreements WHERE agreement_id = ?",
      [id]
    );
    if (!found[0]) {
      res.status(404).json({ message: "Agreement not found." });
      return;
    }
    if (found[0].status !== "Active") {
      res.status(400).json({ message: `Only an active agreement can be terminated. This one is ${found[0].status}.` });
      return;
    }
    // The end date becomes today, so the dates match what really happened
    await pool.query(
      `UPDATE facility_agreements
       SET status = 'Terminated', terminated_reason = ?,
           end_date = GREATEST(start_date, LEAST(end_date, CURDATE()))
       WHERE agreement_id = ?`,
      [reason, id]
    );
    res.json({ message: "Agreement terminated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function deleteAgreement(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  if (!id) {
    res.status(400).json({ message: "Invalid agreement id." });
    return;
  }
  try {
    const [found] = await pool.query<RowDataPacket[]>(
      "SELECT status FROM facility_agreements WHERE agreement_id = ?",
      [id]
    );
    if (!found[0]) {
      res.status(404).json({ message: "Agreement not found." });
      return;
    }
    if (found[0].status !== "Draft") {
      res.status(400).json({ message: "Only a draft can be deleted. Terminate an active agreement instead." });
      return;
    }
    await pool.query("DELETE FROM facility_agreements WHERE agreement_id = ? AND status = 'Draft'", [id]);
    res.json({ message: "Draft agreement deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}
/* ---------- notifications (small helper used by the wellness features) ---------- */

async function notify(
  employeeId: number,
  category: string,
  title: string,
  message: string,
  link: string | null
): Promise<void> {
  try {
    await pool.query(
      "INSERT INTO notifications (employee_id, category, title, message, link) VALUES (?, ?, ?, ?, ?)",
      [employeeId, category, title.slice(0, 150), message.slice(0, 500), link]
    );
  } catch (err) {
    // A failed notification must never undo the real action
    console.error("Could not save a notification", err);
  }
}

/* ---------- enrollment ---------- */

function memberCode(facilityId: number, employeeId: number): string {
  return `FZ-${String(facilityId).padStart(2, "0")}-${String(employeeId).padStart(4, "0")}`;
}

async function enroll(
  facilityId: number,
  employeeId: number,
  doneBy: number
): Promise<{ status: number; message: string }> {
  const conn = await pool.getConnection();
  try {
    await expireAgreements();
    await conn.beginTransaction();

    const [fac] = await conn.query<RowDataPacket[]>(
      `SELECT f.name, f.status, f.opening_hours, f.access_instructions, f.address, ${IN_FORCE_SQL} AS available
       FROM facilities f WHERE f.facility_id = ? FOR UPDATE`,
      [facilityId]
    );
    if (!fac[0] || fac[0].status !== "Active" || !Number(fac[0].available)) {
      await conn.rollback();
      return { status: 404, message: "Facility not found." };
    }

    const [emp] = await conn.query<RowDataPacket[]>(
      "SELECT status FROM employees WHERE employee_id = ?",
      [employeeId]
    );
    if (!emp[0] || emp[0].status !== "Active") {
      await conn.rollback();
      return { status: 400, message: "Only active employees can enroll." };
    }

    const code = memberCode(facilityId, employeeId);
    const [existing] = await conn.query<RowDataPacket[]>(
      "SELECT enrollment_id, status FROM facility_enrollments WHERE facility_id = ? AND employee_id = ?",
      [facilityId, employeeId]
    );

    if (existing[0] && existing[0].status === "Active") {
      await conn.rollback();
      return { status: 409, message: "Already enrolled at this facility." };
    }
    if (existing[0] && existing[0].status === "Suspended") {
      await conn.rollback();
      return { status: 400, message: "This membership is suspended. Please contact HR." };
    }

    if (existing[0]) {
      await conn.query(
        `UPDATE facility_enrollments
         SET status = 'Active', start_date = CURDATE(), end_date = NULL, member_code = ?, enrolled_by = ?
         WHERE enrollment_id = ?`,
        [code, doneBy, existing[0].enrollment_id]
      );
    } else {
      await conn.query(
        `INSERT INTO facility_enrollments (facility_id, employee_id, member_code, start_date, enrolled_by)
         VALUES (?, ?, ?, CURDATE(), ?)`,
        [facilityId, employeeId, code, doneBy]
      );
    }
    await conn.commit();

    const where = [
      fac[0].address ? `Address: ${fac[0].address}.` : "",
      fac[0].opening_hours ? `Hours: ${fac[0].opening_hours}.` : "",
      fac[0].access_instructions ? `How to get in: ${fac[0].access_instructions}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    await notify(
      employeeId,
      "wellness",
      `Welcome to ${fac[0].name}`,
      `Your member code is ${code}. ${where}`,
      "/wellness"
    );
    return { status: 201, message: `Enrolled. Your member code is ${code}.` };
  } catch (err) {
    await conn.rollback();
    console.error(err);
    return { status: 500, message: "Database error" };
  } finally {
    conn.release();
  }
}

export async function enrollMyself(req: AuthedRequest, res: Response): Promise<void> {
  const facilityId = parseInt(String(req.params.id), 10);
  if (!facilityId) {
    res.status(400).json({ message: "Invalid facility id." });
    return;
  }
  const me = await myEmployeeId(req.user!.userId);
  if (!me) {
    res.status(404).json({ message: "No employee profile is linked to this account." });
    return;
  }
  const result = await enroll(facilityId, me, req.user!.userId);
  res.status(result.status).json({ message: result.message });
}

export async function enrollSomeone(req: AuthedRequest, res: Response): Promise<void> {
  const facilityId = parseInt(String(req.params.id), 10);
  const employeeId = parseInt(asText(String(req.body?.employeeId ?? "")), 10);
  if (!facilityId || !employeeId) {
    res.status(400).json({ message: "Choose a facility and an employee." });
    return;
  }
  const result = await enroll(facilityId, employeeId, req.user!.userId);
  res.status(result.status).json({ message: result.message });
}

export async function listMembers(req: AuthedRequest, res: Response): Promise<void> {
  const facilityId = parseInt(String(req.params.id), 10);
  const status = asText(req.query.status);
  if (!facilityId) {
    res.status(400).json({ message: "Invalid facility id." });
    return;
  }
  try {
    const where = ["en.facility_id = ?"];
    const params: (string | number)[] = [facilityId];
    if (["Active", "Suspended", "Ended"].includes(status)) {
      where.push("en.status = ?");
      params.push(status);
    }
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT en.enrollment_id, en.employee_id, e.full_name, e.employee_code, d.department_name,
              en.member_code, en.start_date, en.end_date, en.status,
              (SELECT COUNT(*) FROM facility_visits v
                 WHERE v.facility_id = en.facility_id AND v.employee_id = en.employee_id
                   AND v.status = 'Confirmed'
                   AND YEAR(v.visit_date) = YEAR(CURDATE()) AND MONTH(v.visit_date) = MONTH(CURDATE())) AS visits_this_month
       FROM facility_enrollments en
       JOIN employees e ON e.employee_id = en.employee_id
       JOIN departments d ON d.department_id = e.department_id
       WHERE ${where.join(" AND ")}
       ORDER BY e.full_name`,
      params
    );
    res.json({ data: rows.map((r) => ({ ...r, visits_this_month: Number(r.visits_this_month) })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function changeEnrollment(req: AuthedRequest, res: Response): Promise<void> {
  const enrollmentId = parseInt(String(req.params.enrollmentId), 10);
  const status = asText(req.body?.status);
  const reason = asText(req.body?.reason);
  if (!enrollmentId) {
    res.status(400).json({ message: "Invalid enrollment id." });
    return;
  }
  if (!["Active", "Suspended", "Ended"].includes(status)) {
    res.status(400).json({ message: "Status must be Active, Suspended or Ended." });
    return;
  }
  if (status !== "Active" && reason.length < 3) {
    res.status(400).json({ message: "Please give a reason (at least 3 characters)." });
    return;
  }

  try {
    const [found] = await pool.query<RowDataPacket[]>(
      `SELECT en.employee_id, en.status, f.name
       FROM facility_enrollments en JOIN facilities f ON f.facility_id = en.facility_id
       WHERE en.enrollment_id = ?`,
      [enrollmentId]
    );
    const cur = found[0];
    if (!cur) {
      res.status(404).json({ message: "Enrollment not found." });
      return;
    }
    if (cur.status === status) {
      res.json({ message: "No changes", status });
      return;
    }
    if (cur.status === "Ended") {
      res.status(400).json({ message: "An ended membership cannot be changed. The person can enroll again." });
      return;
    }

    await pool.query(
      "UPDATE facility_enrollments SET status = ?, end_date = IF(? = 'Ended', CURDATE(), NULL) WHERE enrollment_id = ?",
      [status, status, enrollmentId]
    );

    if (status === "Suspended") {
      await notify(cur.employee_id, "wellness", `${cur.name}: membership suspended`, `Your access is suspended. Reason: ${reason}. Please contact HR.`, "/wellness");
    } else if (status === "Ended") {
      await notify(cur.employee_id, "wellness", `${cur.name}: membership ended`, `Your membership has ended. Reason: ${reason}.`, "/wellness");
    } else {
      await notify(cur.employee_id, "wellness", `${cur.name}: access restored`, "Your access has been restored.", "/wellness");
    }
    res.json({ message: `Membership is now ${status}`, status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function listMyMemberships(req: AuthedRequest, res: Response): Promise<void> {
  try {
    await expireAgreements();
    const me = await myEmployeeId(req.user!.userId);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT en.enrollment_id, en.status, en.member_code, en.start_date,
              f.facility_id, f.name, f.facility_type, f.address, f.opening_hours, f.access_instructions, f.phone,
              (SELECT ag.max_visits_per_member_month FROM facility_agreements ag
                 WHERE ag.facility_id = f.facility_id AND ag.status = 'Active'
                   AND ag.start_date <= CURDATE() AND ag.end_date >= CURDATE() LIMIT 1) AS monthly_limit,
              (SELECT COUNT(*) FROM facility_visits v
                 WHERE v.facility_id = f.facility_id AND v.employee_id = en.employee_id
                   AND v.status IN ('Pending','Confirmed')
                   AND YEAR(v.visit_date) = YEAR(CURDATE()) AND MONTH(v.visit_date) = MONTH(CURDATE())) AS visits_this_month,
              (SELECT COUNT(*) FROM facility_visits v
                 WHERE v.facility_id = f.facility_id AND v.employee_id = en.employee_id
                   AND v.visit_date = CURDATE() AND v.status <> 'Rejected') AS visited_today,
              ${IN_FORCE_SQL} AS available
       FROM facility_enrollments en JOIN facilities f ON f.facility_id = en.facility_id
       WHERE en.employee_id = ? AND en.status <> 'Ended'
       ORDER BY f.name`,
      [me]
    );
    res.json({
      data: rows.map((r) => ({
        ...r,
        monthly_limit: r.monthly_limit === null ? null : Number(r.monthly_limit),
        visits_this_month: Number(r.visits_this_month),
        visited_today: Number(r.visited_today) > 0,
        available: Number(r.available) === 1,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

/* ---------- visits ---------- */

// The agreement in force on a date, with its monthly cap
async function agreementOn(facilityId: number, date: string): Promise<RowDataPacket | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT agreement_id, max_visits_per_member_month FROM facility_agreements
     WHERE facility_id = ? AND status IN ('Active','Expired','Terminated')
       AND start_date <= ? AND end_date >= ?
     ORDER BY agreement_id DESC LIMIT 1`,
    [facilityId, date, date]
  );
  return rows[0] ?? null;
}

async function recordVisit(
  facilityId: number,
  employeeId: number,
  date: string,
  source: "Self check-in" | "HR entry",
  note: string | null,
  doneBy: number
): Promise<{ status: number; message: string; visit_id?: number }> {
  const conn = await pool.getConnection();
  try {
    await expireAgreements();
    await conn.beginTransaction();

    const [en] = await conn.query<RowDataPacket[]>(
      "SELECT enrollment_id, status FROM facility_enrollments WHERE facility_id = ? AND employee_id = ? FOR UPDATE",
      [facilityId, employeeId]
    );
    if (!en[0] || en[0].status === "Ended") {
      await conn.rollback();
      return { status: 400, message: "This person is not enrolled at this facility." };
    }
    if (en[0].status === "Suspended") {
      await conn.rollback();
      return { status: 400, message: "This membership is suspended." };
    }

    const agr = await agreementOn(facilityId, date);
    if (!agr) {
      await conn.rollback();
      return { status: 400, message: "There was no agreement with this facility on that date." };
    }

    // The monthly cap counts pending and confirmed visits in that month
    if (agr.max_visits_per_member_month !== null) {
      const [cnt] = await conn.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM facility_visits
         WHERE facility_id = ? AND employee_id = ? AND status IN ('Pending','Confirmed')
           AND YEAR(visit_date) = YEAR(?) AND MONTH(visit_date) = MONTH(?)`,
        [facilityId, employeeId, date, date]
      );
      if (Number(cnt[0].n) >= Number(agr.max_visits_per_member_month)) {
        await conn.rollback();
        return {
          status: 400,
          message: `The limit of ${agr.max_visits_per_member_month} visits a month has been reached.`,
        };
      }
    }

    const [existing] = await conn.query<RowDataPacket[]>(
      "SELECT visit_id, status FROM facility_visits WHERE facility_id = ? AND employee_id = ? AND visit_date = ?",
      [facilityId, employeeId, date]
    );
    if (existing[0] && existing[0].status !== "Rejected") {
      await conn.rollback();
      return { status: 409, message: "A visit is already recorded for that day." };
    }

    const confirmed = source === "HR entry";
    let visitId: number;
    if (existing[0]) {
      // A rejected visit can be recorded again
      await conn.query(
        `UPDATE facility_visits
         SET agreement_id = ?, source = ?, status = ?, note = ?, recorded_by = ?,
             confirmed_by = ?, confirmed_at = ?
         WHERE visit_id = ?`,
        [agr.agreement_id, source, confirmed ? "Confirmed" : "Pending", note, doneBy,
         confirmed ? doneBy : null, confirmed ? new Date() : null, existing[0].visit_id]
      );
      visitId = existing[0].visit_id;
    } else {
      const [ins] = await conn.query<ResultSetHeader>(
        `INSERT INTO facility_visits
           (facility_id, agreement_id, employee_id, visit_date, source, status, note, recorded_by, confirmed_by, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [facilityId, agr.agreement_id, employeeId, date, source, confirmed ? "Confirmed" : "Pending", note,
         doneBy, confirmed ? doneBy : null, confirmed ? new Date() : null]
      );
      visitId = ins.insertId;
    }
    await conn.commit();
    return {
      status: 201,
      message: confirmed ? "Visit recorded and confirmed." : "Visit recorded. HR will confirm it.",
      visit_id: visitId,
    };
  } catch (err) {
    await conn.rollback();
    console.error(err);
    return { status: 500, message: "Database error" };
  } finally {
    conn.release();
  }
}

export async function checkIn(req: AuthedRequest, res: Response): Promise<void> {
  const facilityId = parseInt(String(req.params.id), 10);
  if (!facilityId) {
    res.status(400).json({ message: "Invalid facility id." });
    return;
  }
  const me = await myEmployeeId(req.user!.userId);
  if (!me) {
    res.status(404).json({ message: "No employee profile is linked to this account." });
    return;
  }
  const note = asText(req.body?.note) || null;
  if (note && note.length > 255) {
    res.status(400).json({ message: "The note must be 255 characters or fewer." });
    return;
  }
  // Employees can only check in for today
  const result = await recordVisit(facilityId, me, todayString(), "Self check-in", note, req.user!.userId);
  res.status(result.status).json({ message: result.message, visit_id: result.visit_id });
}

export async function recordVisitForMember(req: AuthedRequest, res: Response): Promise<void> {
  const facilityId = parseInt(String(req.params.id), 10);
  const employeeId = parseInt(asText(String(req.body?.employeeId ?? "")), 10);
  const date = asText(req.body?.visitDate) || todayString();
  const note = asText(req.body?.note) || null;

  if (!facilityId || !employeeId) {
    res.status(400).json({ message: "Choose a facility and an employee." });
    return;
  }
  if (!isValidDate(date)) {
    res.status(400).json({ message: "The visit date must be YYYY-MM-DD." });
    return;
  }
  if (date > todayString()) {
    res.status(400).json({ message: "A visit cannot be recorded for a future date." });
    return;
  }
  if (note && note.length > 255) {
    res.status(400).json({ message: "The note must be 255 characters or fewer." });
    return;
  }
  const result = await recordVisit(facilityId, employeeId, date, "HR entry", note, req.user!.userId);
  res.status(result.status).json({ message: result.message, visit_id: result.visit_id });
}

export async function reviewVisit(req: AuthedRequest, res: Response): Promise<void> {
  const visitId = parseInt(String(req.params.visitId), 10);
  const decision = asText(req.body?.decision);
  const reason = asText(req.body?.reason);
  if (!visitId) {
    res.status(400).json({ message: "Invalid visit id." });
    return;
  }
  if (decision !== "Confirmed" && decision !== "Rejected") {
    res.status(400).json({ message: "The decision must be Confirmed or Rejected." });
    return;
  }
  if (decision === "Rejected" && reason.length < 3) {
    res.status(400).json({ message: "Please give a reason for rejecting (at least 3 characters)." });
    return;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [found] = await conn.query<RowDataPacket[]>(
      `SELECT v.employee_id, v.status, v.visit_date, f.name
       FROM facility_visits v JOIN facilities f ON f.facility_id = v.facility_id
       WHERE v.visit_id = ? FOR UPDATE`,
      [visitId]
    );
    const cur = found[0];
    if (!cur) {
      await conn.rollback();
      res.status(404).json({ message: "Visit not found." });
      return;
    }
    if (cur.status !== "Pending") {
      await conn.rollback();
      res.status(409).json({ message: `This visit is already ${cur.status.toLowerCase()}.` });
      return;
    }

    // A statement that is already approved cannot change afterwards
    const [locked] = await conn.query<RowDataPacket[]>(
      `SELECT s.statement_id FROM facility_statements s
       JOIN facility_visits v ON v.agreement_id = s.agreement_id
       WHERE v.visit_id = ? AND s.period_year = YEAR(v.visit_date) AND s.period_month = MONTH(v.visit_date)
         AND s.status <> 'Draft' LIMIT 1`,
      [visitId]
    );
    if (locked[0]) {
      await conn.rollback();
      res.status(400).json({ message: "That month's statement is already approved, so this visit can no longer be reviewed." });
      return;
    }

    await conn.query(
      `UPDATE facility_visits
       SET status = ?, confirmed_by = ?, confirmed_at = NOW(), note = COALESCE(?, note)
       WHERE visit_id = ?`,
      [decision, req.user?.userId ?? null, decision === "Rejected" ? `Rejected: ${reason}`.slice(0, 255) : null, visitId]
    );
    await conn.commit();

    if (decision === "Rejected") {
      await notify(
        cur.employee_id,
        "wellness",
        `${cur.name}: visit not accepted`,
        `Your visit on ${dateOnly(cur.visit_date)} was not accepted. Reason: ${reason}.`,
        "/wellness"
      );
    }
    res.json({ message: `Visit ${decision.toLowerCase()}`, status: decision });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: "Database error" });
  } finally {
    conn.release();
  }
}

export async function listVisits(req: AuthedRequest, res: Response): Promise<void> {
  const page = Math.max(parseInt(asText(req.query.page), 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(asText(req.query.limit), 10) || 20, 1), 100);
  const facilityId = parseInt(asText(req.query.facility_id), 10) || null;
  const status = asText(req.query.status);
  const month = asText(req.query.month); // YYYY-MM

  try {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (facilityId) {
      where.push("v.facility_id = ?");
      params.push(facilityId);
    }
    if (["Pending", "Confirmed", "Rejected"].includes(status)) {
      where.push("v.status = ?");
      params.push(status);
    }
    if (/^\d{4}-\d{2}$/.test(month)) {
      where.push("DATE_FORMAT(v.visit_date, '%Y-%m') = ?");
      params.push(month);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT v.visit_id, v.visit_date, v.source, v.status, v.note, f.facility_id, f.name AS facility_name,
              e.employee_id, e.full_name, e.employee_code, rv.full_name AS reviewed_by_name
       FROM facility_visits v
       JOIN facilities f ON f.facility_id = v.facility_id
       JOIN employees e ON e.employee_id = v.employee_id
       LEFT JOIN users rv ON rv.user_id = v.confirmed_by
       ${whereSql}
       ORDER BY (v.status = 'Pending') DESC, v.visit_date DESC, v.visit_id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );
    const [count] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM facility_visits v ${whereSql}`,
      params
    );
    const total = Number(count[0].total);
    res.json({ data: rows, meta: { total, page, limit, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function listMyVisits(req: AuthedRequest, res: Response): Promise<void> {
  try {
    const me = await myEmployeeId(req.user!.userId);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT v.visit_id, v.visit_date, v.source, v.status, v.note, f.name AS facility_name
       FROM facility_visits v JOIN facilities f ON f.facility_id = v.facility_id
       WHERE v.employee_id = ?
       ORDER BY v.visit_date DESC, v.visit_id DESC LIMIT 200`,
      [me]
    );
    res.json({ data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

/* ---------- notification inbox (basic) ---------- */

export async function listMyNotifications(req: AuthedRequest, res: Response): Promise<void> {
  try {
    const me = await myEmployeeId(req.user!.userId);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT notification_id, category, title, message, link, is_read, created_at
       FROM notifications WHERE employee_id = ?
       ORDER BY created_at DESC, notification_id DESC LIMIT 100`,
      [me]
    );
    const [unread] = await pool.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM notifications WHERE employee_id = ? AND is_read = 0",
      [me]
    );
    res.json({ data: rows.map((r) => ({ ...r, is_read: Number(r.is_read) === 1 })), unread: Number(unread[0].n) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function markNotificationsRead(req: AuthedRequest, res: Response): Promise<void> {
  try {
    const me = await myEmployeeId(req.user!.userId);
    const ids: unknown = req.body?.ids;
    if (Array.isArray(ids) && ids.length && ids.every((n) => Number.isInteger(n))) {
      await pool.query("UPDATE notifications SET is_read = 1 WHERE employee_id = ? AND notification_id IN (?)", [me, ids]);
    } else {
      await pool.query("UPDATE notifications SET is_read = 1 WHERE employee_id = ?", [me]);
    }
    res.json({ message: "Marked as read." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}