import type { Response } from "express";
import type { RowDataPacket, ResultSetHeader } from "mysql2";
import { pool } from "../db";
import type { AuthedRequest } from "../middleware/auth";

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function flag(value: unknown): number | null {
  if (value === true || value === 1 || value === "1") return 1;
  if (value === false || value === 0 || value === "0") return 0;
  return null;
}

function yesNo(value: unknown): string {
  return Number(value) === 1 ? "Yes" : "No";
}

interface ChangeItem {
  field: string;
  from: string;
  to: string;
}

async function audit(
  userId: number | undefined,
  action: string,
  entity: string,
  entityId: number | null,
  details: unknown
): Promise<void> {
  try {
    await pool.query(
      "INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?)",
      [userId ?? null, action, entity, entityId, JSON.stringify(details)]
    );
  } catch (err) {
    console.error("Could not write the change log", err);
  }
}

/* ---------- leave types ---------- */

interface LeaveTypeInput {
  name: string;
  days: number;
  isPaid: number;
  requiresDocument: number;
  autoApprove: number;
  maxBackdate: number;
}

function parseLeaveType(body: unknown): { error?: string; value?: LeaveTypeInput } {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = asText(b.name);
  const days = Number(b.daysAllowed);
  const maxBackdate = Number(b.maxBackdateDays ?? 0);
  const isPaid = flag(b.isPaid);
  const requiresDocument = flag(b.requiresDocument);
  const autoApprove = flag(b.autoApprove);

  if (!name) return { error: "The name is required." };
  if (name.length > 50) return { error: "The name must be 50 characters or fewer." };
  if (!Number.isInteger(days) || days < 0 || days > 365) {
    return { error: "Days per year must be a whole number from 0 to 365." };
  }
  if (!Number.isInteger(maxBackdate) || maxBackdate < 0 || maxBackdate > 365) {
    return { error: "Back-dating must be a whole number of days from 0 to 365." };
  }
  if (isPaid === null || requiresDocument === null || autoApprove === null) {
    return { error: "Invalid yes or no setting." };
  }
  if (autoApprove === 1 && requiresDocument === 0) {
    return {
      error: "Automatic approval needs a supporting document, so turn on the document requirement first.",
    };
  }
  return { value: { name, days, isPaid, requiresDocument, autoApprove, maxBackdate } };
}

export async function listLeaveTypes(_req: AuthedRequest, res: Response): Promise<void> {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT t.leave_type_id, t.type_name, t.days_allowed_per_year, t.is_paid,
              t.requires_document, t.auto_approve, t.max_backdate_days,
              (SELECT COUNT(*) FROM leave_requests r WHERE r.leave_type_id = t.leave_type_id) AS requests
       FROM leave_types t
       ORDER BY t.leave_type_id`
    );
    res.json({ data: rows.map((r) => ({ ...r, requests: Number(r.requests) })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function createLeaveType(req: AuthedRequest, res: Response): Promise<void> {
  const parsed = parseLeaveType(req.body);
  if (parsed.error || !parsed.value) {
    res.status(400).json({ message: parsed.error });
    return;
  }
  const v = parsed.value;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [ins] = await conn.query<ResultSetHeader>(
      `INSERT INTO leave_types
         (type_name, days_allowed_per_year, is_paid, requires_document, auto_approve, max_backdate_days)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [v.name, v.days, v.isPaid, v.requiresDocument, v.autoApprove, v.maxBackdate]
    );
    // Every active employee gets a balance for this year
    await conn.query(
      `INSERT INTO leave_balances (employee_id, leave_type_id, year, days_allocated, days_used)
       SELECT employee_id, ?, YEAR(CURDATE()), ?, 0 FROM employees WHERE status = 'Active'`,
      [ins.insertId, v.days]
    );
    await conn.commit();

    await audit(req.user?.userId, "created", "leave_type", ins.insertId, {
      name: v.name,
      changes: [{ field: "Days per year", from: "", to: String(v.days) }],
    });
    res.status(201).json({ message: `Leave type "${v.name}" added`, leave_type_id: ins.insertId });
  } catch (err) {
    await conn.rollback();
    const e = err as { code?: string };
    if (e.code === "ER_DUP_ENTRY") {
      res.status(409).json({ message: "A leave type with that name already exists." });
    } else {
      console.error(err);
      res.status(500).json({ message: "Database error" });
    }
  } finally {
    conn.release();
  }
}

export async function updateLeaveType(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  if (!id) {
    res.status(400).json({ message: "Invalid leave type id." });
    return;
  }
  const parsed = parseLeaveType(req.body);
  if (parsed.error || !parsed.value) {
    res.status(400).json({ message: parsed.error });
    return;
  }
  const v = parsed.value;
  const apply = (req.body ?? {}).applyToBalances === true;

  const conn = await pool.getConnection();
  try {
    const [found] = await conn.query<RowDataPacket[]>(
      "SELECT * FROM leave_types WHERE leave_type_id = ?",
      [id]
    );
    const old = found[0];
    if (!old) {
      res.status(404).json({ message: "Leave type not found." });
      return;
    }
    if (old.type_name === "Annual" && v.name !== "Annual") {
      res.status(400).json({
        message: "The Annual leave type is used by other parts of the system, so it cannot be renamed.",
      });
      return;
    }

    const changes: ChangeItem[] = [];
    const diff = (field: string, from: unknown, to: unknown) => {
      if (String(from) !== String(to)) changes.push({ field, from: String(from), to: String(to) });
    };
    diff("Name", old.type_name, v.name);
    diff("Days per year", old.days_allowed_per_year, v.days);
    diff("Paid", yesNo(old.is_paid), yesNo(v.isPaid));
    diff("Needs document", yesNo(old.requires_document), yesNo(v.requiresDocument));
    diff("Approved automatically", yesNo(old.auto_approve), yesNo(v.autoApprove));
    diff("Back-dating allowed (days)", old.max_backdate_days, v.maxBackdate);

    if (changes.length === 0) {
      res.json({ message: "No changes" });
      return;
    }

    await conn.beginTransaction();
    await conn.query(
      `UPDATE leave_types
       SET type_name = ?, days_allowed_per_year = ?, is_paid = ?, requires_document = ?,
           auto_approve = ?, max_backdate_days = ?
       WHERE leave_type_id = ?`,
      [v.name, v.days, v.isPaid, v.requiresDocument, v.autoApprove, v.maxBackdate, id]
    );

    // Optional: move this year's balances by the same difference. Used days are kept.
    const delta = v.days - Number(old.days_allowed_per_year);
    let applied = 0;
    if (apply && delta !== 0) {
      const [r] = await conn.query<ResultSetHeader>(
        `UPDATE leave_balances
         SET days_allocated = GREATEST(days_allocated + ?, days_used)
         WHERE leave_type_id = ? AND year = YEAR(CURDATE())`,
        [delta, id]
      );
      applied = r.affectedRows;
      changes.push({ field: "This year's balances", from: "", to: `${applied} updated` });
    }
    await conn.commit();

    await audit(req.user?.userId, "updated", "leave_type", id, { name: v.name, changes });
    res.json({
      message: applied > 0 ? `Saved. ${applied} balances updated for this year.` : "Saved",
    });
  } catch (err) {
    await conn.rollback();
    const e = err as { code?: string };
    if (e.code === "ER_DUP_ENTRY") {
      res.status(409).json({ message: "A leave type with that name already exists." });
    } else {
      console.error(err);
      res.status(500).json({ message: "Database error" });
    }
  } finally {
    conn.release();
  }
}

export async function deleteLeaveType(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  if (!id) {
    res.status(400).json({ message: "Invalid leave type id." });
    return;
  }

  const conn = await pool.getConnection();
  try {
    const [found] = await conn.query<RowDataPacket[]>(
      `SELECT t.type_name,
              (SELECT COUNT(*) FROM leave_requests r WHERE r.leave_type_id = t.leave_type_id) AS requests,
              (SELECT COALESCE(SUM(b.days_used), 0) FROM leave_balances b
                 WHERE b.leave_type_id = t.leave_type_id) AS used_days
       FROM leave_types t WHERE t.leave_type_id = ?`,
      [id]
    );
    const t = found[0];
    if (!t) {
      res.status(404).json({ message: "Leave type not found." });
      return;
    }
    if (t.type_name === "Annual") {
      res.status(400).json({
        message: "The Annual leave type is used by other parts of the system and cannot be deleted.",
      });
      return;
    }
    if (Number(t.requests) > 0 || Number(t.used_days) > 0) {
      res.status(409).json({
        message: `This leave type has been used (${Number(t.requests)} request(s)), so it cannot be deleted.`,
      });
      return;
    }

    await conn.beginTransaction();
    await conn.query("DELETE FROM leave_balances WHERE leave_type_id = ?", [id]);
    await conn.query("DELETE FROM leave_types WHERE leave_type_id = ?", [id]);
    await conn.commit();

    await audit(req.user?.userId, "deleted", "leave_type", id, { name: t.type_name });
    res.json({ message: `Leave type "${t.type_name}" deleted` });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: "Database error" });
  } finally {
    conn.release();
  }
}

/* ---------- departments ---------- */

function parseDepartmentName(body: unknown): { error?: string; name?: string } {
  const name = asText(((body ?? {}) as Record<string, unknown>).name);
  if (!name) return { error: "The department name is required." };
  if (name.length > 100) return { error: "The name must be 100 characters or fewer." };
  return { name };
}

export async function listDepartments(_req: AuthedRequest, res: Response): Promise<void> {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT d.department_id, d.department_name,
              (SELECT COUNT(*) FROM employees e WHERE e.department_id = d.department_id) AS employees,
              (SELECT COUNT(*) FROM vacancies v WHERE v.department_id = d.department_id) AS vacancies
       FROM departments d
       ORDER BY d.department_name`
    );
    res.json({
      data: rows.map((r) => ({
        ...r,
        employees: Number(r.employees),
        vacancies: Number(r.vacancies),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function createDepartment(req: AuthedRequest, res: Response): Promise<void> {
  const parsed = parseDepartmentName(req.body);
  if (parsed.error || !parsed.name) {
    res.status(400).json({ message: parsed.error });
    return;
  }
  try {
    const [ins] = await pool.query<ResultSetHeader>(
      "INSERT INTO departments (department_name) VALUES (?)",
      [parsed.name]
    );
    await audit(req.user?.userId, "created", "department", ins.insertId, { name: parsed.name });
    res.status(201).json({ message: `Department "${parsed.name}" added` });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "ER_DUP_ENTRY") {
      res.status(409).json({ message: "A department with that name already exists." });
    } else {
      console.error(err);
      res.status(500).json({ message: "Database error" });
    }
  }
}

export async function renameDepartment(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  const parsed = parseDepartmentName(req.body);
  if (!id) {
    res.status(400).json({ message: "Invalid department id." });
    return;
  }
  if (parsed.error || !parsed.name) {
    res.status(400).json({ message: parsed.error });
    return;
  }
  try {
    const [found] = await pool.query<RowDataPacket[]>(
      "SELECT department_name FROM departments WHERE department_id = ?",
      [id]
    );
    if (!found[0]) {
      res.status(404).json({ message: "Department not found." });
      return;
    }
    if (found[0].department_name === parsed.name) {
      res.json({ message: "No changes" });
      return;
    }
    await pool.query("UPDATE departments SET department_name = ? WHERE department_id = ?", [
      parsed.name,
      id,
    ]);
    await audit(req.user?.userId, "updated", "department", id, {
      name: parsed.name,
      changes: [{ field: "Name", from: String(found[0].department_name), to: parsed.name }],
    });
    res.json({ message: "Department renamed" });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "ER_DUP_ENTRY") {
      res.status(409).json({ message: "A department with that name already exists." });
    } else {
      console.error(err);
      res.status(500).json({ message: "Database error" });
    }
  }
}

export async function deleteDepartment(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  if (!id) {
    res.status(400).json({ message: "Invalid department id." });
    return;
  }
  try {
    const [found] = await pool.query<RowDataPacket[]>(
      `SELECT d.department_name,
              (SELECT COUNT(*) FROM employees e WHERE e.department_id = d.department_id) AS employees,
              (SELECT COUNT(*) FROM vacancies v WHERE v.department_id = d.department_id) AS vacancies
       FROM departments d WHERE d.department_id = ?`,
      [id]
    );
    const d = found[0];
    if (!d) {
      res.status(404).json({ message: "Department not found." });
      return;
    }
    if (Number(d.employees) > 0 || Number(d.vacancies) > 0) {
      res.status(409).json({
        message: `This department has ${Number(d.employees)} employee(s) and ${Number(d.vacancies)} vacancy record(s), so it cannot be deleted. Move them first.`,
      });
      return;
    }
    await pool.query("DELETE FROM departments WHERE department_id = ?", [id]);
    await audit(req.user?.userId, "deleted", "department", id, { name: d.department_name });
    res.json({ message: `Department "${d.department_name}" deleted` });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "ER_ROW_IS_REFERENCED_2") {
      res.status(409).json({ message: "This department is still in use, so it cannot be deleted." });
    } else {
      console.error(err);
      res.status(500).json({ message: "Database error" });
    }
  }
}

/* ---------- change log ---------- */

export async function listChanges(_req: AuthedRequest, res: Response): Promise<void> {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT a.id, a.action, a.entity, a.entity_id, a.details, a.created_at,
              e.full_name AS changed_by
       FROM audit_log a
       LEFT JOIN users u ON u.user_id = a.user_id
       LEFT JOIN employees e ON e.employee_id = u.employee_id
       WHERE a.entity IN ('leave_type', 'department')
       ORDER BY a.id DESC
       LIMIT 50`
    );
    res.json({ data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}