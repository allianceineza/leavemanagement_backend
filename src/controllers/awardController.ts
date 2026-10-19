import type { Response } from "express";
import type { RowDataPacket, ResultSetHeader } from "mysql2";
import { pool } from "../db";
import type { AuthedRequest } from "../middleware/auth";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isValidDate(value: string): boolean {
  return DATE_RE.test(value) && !Number.isNaN(new Date(value + "T00:00:00").getTime());
}

function todayString(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

async function myEmployee(userId: number): Promise<{ employee_id: number; department_id: number } | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT e.employee_id, e.department_id
     FROM users u JOIN employees e ON e.employee_id = u.employee_id
     WHERE u.user_id = ?`,
    [userId]
  );
  return rows[0] ? { employee_id: rows[0].employee_id, department_id: rows[0].department_id } : null;
}

const AWARD_COLUMNS = `a.award_id, a.award_date, a.reason, a.status,
       e.employee_id, e.full_name, e.employee_code, d.department_name,
       t.award_type_id, t.name AS award_name, g.full_name AS awarded_by_name`;

const AWARD_JOINS = `FROM employee_awards a
       JOIN employees e ON e.employee_id = a.employee_id
       JOIN departments d ON d.department_id = e.department_id
       JOIN award_types t ON t.award_type_id = a.award_type_id
       LEFT JOIN users g ON g.user_id = a.awarded_by`;

/* ---------- award types (HR) ---------- */

export async function listAwardTypes(req: AuthedRequest, res: Response): Promise<void> {
  const showAll = asText(req.query.all) === "1";
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT t.award_type_id, t.name, t.description, t.is_active,
              (SELECT COUNT(*) FROM employee_awards a
                 WHERE a.award_type_id = t.award_type_id AND a.status = 'Awarded') AS times_given
       FROM award_types t
       ${showAll ? "" : "WHERE t.is_active = 1"}
       ORDER BY t.name`
    );
    res.json({ data: rows.map((r) => ({ ...r, times_given: Number(r.times_given) })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function createAwardType(req: AuthedRequest, res: Response): Promise<void> {
  const name = asText(req.body?.name);
  const description = asText(req.body?.description) || null;

  if (!name) {
    res.status(400).json({ message: "A name is required." });
    return;
  }
  if (name.length > 100) {
    res.status(400).json({ message: "The name must be 100 characters or fewer." });
    return;
  }
  if (description && description.length > 255) {
    res.status(400).json({ message: "The description must be 255 characters or fewer." });
    return;
  }

  try {
    const [r] = await pool.query<ResultSetHeader>(
      "INSERT INTO award_types (name, description) VALUES (?, ?)",
      [name, description]
    );
    res.status(201).json({ message: "Award type created", award_type_id: r.insertId });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "ER_DUP_ENTRY") {
      res.status(409).json({ message: "An award type with this name already exists." });
    } else {
      console.error(err);
      res.status(500).json({ message: "Database error" });
    }
  }
}

export async function updateAwardType(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  const b = req.body ?? {};
  if (!id) {
    res.status(400).json({ message: "Invalid award type id." });
    return;
  }

  try {
    const [found] = await pool.query<RowDataPacket[]>(
      "SELECT name, description, is_active FROM award_types WHERE award_type_id = ?",
      [id]
    );
    const current = found[0];
    if (!current) {
      res.status(404).json({ message: "Award type not found." });
      return;
    }

    const name = b.name === undefined ? current.name : asText(b.name);
    const description = b.description === undefined ? current.description : asText(b.description) || null;
    const isActive = b.isActive === undefined ? Number(current.is_active) : b.isActive ? 1 : 0;

    if (!name || name.length > 100) {
      res.status(400).json({ message: "The name is required and must be 100 characters or fewer." });
      return;
    }
    if (description && description.length > 255) {
      res.status(400).json({ message: "The description must be 255 characters or fewer." });
      return;
    }

    await pool.query(
      "UPDATE award_types SET name = ?, description = ?, is_active = ? WHERE award_type_id = ?",
      [name, description, isActive, id]
    );
    res.json({ message: "Award type updated" });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "ER_DUP_ENTRY") {
      res.status(409).json({ message: "An award type with this name already exists." });
    } else {
      console.error(err);
      res.status(500).json({ message: "Database error" });
    }
  }
}

/* ---------- giving awards (HR) ---------- */

export async function createAward(req: AuthedRequest, res: Response): Promise<void> {
  const b = req.body ?? {};
  const employeeId = parseInt(asText(String(b.employeeId ?? "")), 10);
  const awardTypeId = parseInt(asText(String(b.awardTypeId ?? "")), 10);
  const awardDate = asText(b.awardDate) || todayString();
  const reason = asText(b.reason);

  const errors: string[] = [];
  if (!employeeId) errors.push("Choose an employee.");
  if (!awardTypeId) errors.push("Choose an award type.");
  if (!isValidDate(awardDate)) errors.push("The award date must be YYYY-MM-DD.");
  else if (awardDate > todayString()) errors.push("The award date cannot be in the future.");
  if (reason.length < 3) errors.push("Please give the reason for the award (at least 3 characters).");
  if (reason.length > 500) errors.push("The reason must be 500 characters or fewer.");
  if (errors.length) {
    res.status(400).json({ message: errors[0], errors });
    return;
  }

  const conn = await pool.getConnection();
  try {
    const me = await myEmployee(req.user!.userId);
    if (me && me.employee_id === employeeId) {
      res.status(400).json({ message: "You cannot give an award to yourself." });
      return;
    }

    const [emp] = await conn.query<RowDataPacket[]>(
      "SELECT status FROM employees WHERE employee_id = ?",
      [employeeId]
    );
    if (!emp[0]) {
      res.status(404).json({ message: "Employee not found." });
      return;
    }
    if (emp[0].status !== "Active") {
      res.status(400).json({ message: "Awards can only be given to active employees." });
      return;
    }

    const [type] = await conn.query<RowDataPacket[]>(
      "SELECT name, is_active FROM award_types WHERE award_type_id = ?",
      [awardTypeId]
    );
    if (!type[0]) {
      res.status(404).json({ message: "Award type not found." });
      return;
    }
    if (!Number(type[0].is_active)) {
      res.status(400).json({ message: "This award type is no longer active." });
      return;
    }

    await conn.beginTransaction();
    const [ins] = await conn.query<ResultSetHeader>(
      `INSERT INTO employee_awards (employee_id, award_type_id, award_date, reason, status, awarded_by)
       VALUES (?, ?, ?, ?, 'Awarded', ?)`,
      [employeeId, awardTypeId, awardDate, reason, req.user?.userId ?? null]
    );
    await conn.query(
      `INSERT INTO employee_history (employee_id, change_type, old_values, new_values, changed_by)
       VALUES (?, 'award_given', NULL, ?, ?)`,
      [employeeId, JSON.stringify({ award: type[0].name, date: awardDate }), req.user?.userId ?? null]
    );
    await conn.commit();
    res.status(201).json({ message: "Award given", award_id: ins.insertId });
  } catch (err) {
    await conn.rollback();
    const e = err as { code?: string };
    if (e.code === "ER_DUP_ENTRY") {
      res.status(409).json({ message: "This employee already has this award on that date." });
    } else {
      console.error(err);
      res.status(500).json({ message: "Database error" });
    }
  } finally {
    conn.release();
  }
}

export async function updateAward(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  const b = req.body ?? {};
  if (!id) {
    res.status(400).json({ message: "Invalid award id." });
    return;
  }

  const updates: Record<string, string | number> = {};
  const errors: string[] = [];

  if (b.reason !== undefined) {
    const reason = asText(b.reason);
    if (reason.length < 3) errors.push("Please give the reason for the award (at least 3 characters).");
    else if (reason.length > 500) errors.push("The reason must be 500 characters or fewer.");
    else updates.reason = reason;
  }
  if (b.awardDate !== undefined) {
    const d = asText(b.awardDate);
    if (!isValidDate(d)) errors.push("The award date must be YYYY-MM-DD.");
    else if (d > todayString()) errors.push("The award date cannot be in the future.");
    else updates.award_date = d;
  }
  if (b.awardTypeId !== undefined) {
    const t = parseInt(asText(String(b.awardTypeId)), 10);
    if (!t) errors.push("Choose an award type.");
    else updates.award_type_id = t;
  }
  if (errors.length) {
    res.status(400).json({ message: errors[0], errors });
    return;
  }
  if (!Object.keys(updates).length) {
    res.status(400).json({ message: "Nothing to update." });
    return;
  }

  try {
    const [found] = await pool.query<RowDataPacket[]>(
      "SELECT award_id FROM employee_awards WHERE award_id = ?",
      [id]
    );
    if (!found[0]) {
      res.status(404).json({ message: "Award not found." });
      return;
    }

    if (updates.award_type_id !== undefined) {
      const [type] = await pool.query<RowDataPacket[]>(
        "SELECT is_active FROM award_types WHERE award_type_id = ?",
        [updates.award_type_id]
      );
      if (!type[0]) {
        res.status(404).json({ message: "Award type not found." });
        return;
      }
      if (!Number(type[0].is_active)) {
        res.status(400).json({ message: "This award type is no longer active." });
        return;
      }
    }

    const cols = Object.keys(updates);
    await pool.query(
      `UPDATE employee_awards SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE award_id = ?`,
      [...cols.map((c) => updates[c]), id]
    );
    res.json({ message: "Award updated" });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "ER_DUP_ENTRY") {
      res.status(409).json({ message: "This employee already has this award on that date." });
    } else {
      console.error(err);
      res.status(500).json({ message: "Database error" });
    }
  }
}

export async function deleteAward(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  if (!id) {
    res.status(400).json({ message: "Invalid award id." });
    return;
  }

  const conn = await pool.getConnection();
  try {
    const [found] = await conn.query<RowDataPacket[]>(
      `SELECT a.employee_id, a.award_date, t.name
       FROM employee_awards a JOIN award_types t ON t.award_type_id = a.award_type_id
       WHERE a.award_id = ?`,
      [id]
    );
    const row = found[0];
    if (!row) {
      res.status(404).json({ message: "Award not found." });
      return;
    }

    await conn.beginTransaction();
    await conn.query("DELETE FROM employee_awards WHERE award_id = ?", [id]);
    // The removal stays on record, so an award cannot vanish without a trace
    await conn.query(
      `INSERT INTO employee_history (employee_id, change_type, old_values, new_values, changed_by)
       VALUES (?, 'award_removed', ?, NULL, ?)`,
      [
        row.employee_id,
        JSON.stringify({ award: row.name, date: String(row.award_date).slice(0, 10) }),
        req.user?.userId ?? null,
      ]
    );
    await conn.commit();
    res.json({ message: "Award removed" });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: "Database error" });
  } finally {
    conn.release();
  }
}

/* ---------- viewing awards ---------- */

export async function listAwards(req: AuthedRequest, res: Response): Promise<void> {
  const page = Math.max(parseInt(asText(req.query.page), 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(asText(req.query.limit), 10) || 20, 1), 100);
  const search = asText(req.query.search);
  const awardTypeId = parseInt(asText(req.query.award_type_id), 10) || null;
  const employeeId = parseInt(asText(req.query.employee_id), 10) || null;
  const year = parseInt(asText(req.query.year), 10) || null;

  try {
    const where: string[] = ["a.status = 'Awarded'"];
    const params: (string | number)[] = [];

    // A manager sees awards for their own department only
    if (req.user!.role === "Manager") {
      const me = await myEmployee(req.user!.userId);
      if (!me) {
        res.json({ data: [], meta: { total: 0, page, limit, pages: 0 } });
        return;
      }
      where.push("e.department_id = ?");
      params.push(me.department_id);
    }

    if (search) {
      const like = `%${search}%`;
      where.push("(e.full_name LIKE ? OR e.employee_code LIKE ?)");
      params.push(like, like);
    }
    if (awardTypeId) {
      where.push("a.award_type_id = ?");
      params.push(awardTypeId);
    }
    if (employeeId) {
      where.push("a.employee_id = ?");
      params.push(employeeId);
    }
    if (year) {
      where.push("YEAR(a.award_date) = ?");
      params.push(year);
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT ${AWARD_COLUMNS}
       ${AWARD_JOINS}
       ${whereSql}
       ORDER BY a.award_date DESC, a.award_id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );
    const [count] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total
       FROM employee_awards a JOIN employees e ON e.employee_id = a.employee_id
       ${whereSql}`,
      params
    );
    const total = Number(count[0].total);

    res.json({ data: rows, meta: { total, page, limit, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function listMyAwards(req: AuthedRequest, res: Response): Promise<void> {
  try {
    const me = await myEmployee(req.user!.userId);
    if (!me) {
      res.status(404).json({ message: "No employee profile is linked to this account." });
      return;
    }
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT ${AWARD_COLUMNS}
       ${AWARD_JOINS}
       WHERE a.employee_id = ? AND a.status = 'Awarded'
       ORDER BY a.award_date DESC, a.award_id DESC`,
      [me.employee_id]
    );
    res.json({ data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}