import type { Response } from "express";
import type { RowDataPacket, ResultSetHeader } from "mysql2";
import bcrypt from "bcryptjs";
import { pool } from "../db";
import type { AuthedRequest } from "../middleware/auth";

const STATUSES = ["Active", "Inactive", "Terminated"];
const GENDERS = ["Male", "Female", "Other"];
const CREATABLE_ROLES = ["Employee", "Manager"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function orNull(value: unknown): string | null {
  return asText(value) || null;
}

/* ---------- helpers ---------- */

async function currentEmployee(userId: number): Promise<RowDataPacket | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT e.employee_id, e.department_id
     FROM users u JOIN employees e ON e.employee_id = u.employee_id
     WHERE u.user_id = ?`,
    [userId]
  );
  return rows[0] ?? null;
}

async function loadEmployee(id: number): Promise<RowDataPacket | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT e.employee_id, e.employee_code, e.full_name, e.email, e.phone,
            e.national_id, e.gender, e.date_of_birth, e.address,
            e.department_id, d.department_name, e.job_title, e.hire_date,
            e.manager_id, m.full_name AS manager_name,
            e.status, e.status_reason, e.created_at, e.updated_at, u.role
     FROM employees e
     JOIN departments d ON d.department_id = e.department_id
     LEFT JOIN employees m ON m.employee_id = e.manager_id
     LEFT JOIN users u ON u.employee_id = e.employee_id
     WHERE e.employee_id = ?`,
    [id]
  );
  return rows[0] ?? null;
}

/* ---------- list ---------- */

export async function listEmployees(req: AuthedRequest, res: Response): Promise<void> {
  const page = Math.max(parseInt(asText(req.query.page), 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(asText(req.query.limit), 10) || 10, 1), 100);
  const search = asText(req.query.search);
  const status = asText(req.query.status);
  let departmentId: number | null = parseInt(asText(req.query.department_id), 10) || null;

  try {
    // A manager can only see their own department
    if (req.user?.role === "Manager") {
      const me = await currentEmployee(req.user.userId);
      departmentId = me?.department_id ?? null;
      if (!departmentId) {
        res.json({ data: [], meta: { total: 0, page, limit, pages: 0 } });
        return;
      }
    }

    const where: string[] = [];
    const params: (string | number)[] = [];

    if (search) {
      const like = `%${search}%`;
      where.push("(e.full_name LIKE ? OR e.email LIKE ? OR e.employee_code LIKE ?)");
      params.push(like, like, like);
    }
    if (departmentId) {
      where.push("e.department_id = ?");
      params.push(departmentId);
    }
    if (STATUSES.includes(status)) {
      where.push("e.status = ?");
      params.push(status);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT e.employee_id, e.employee_code, e.full_name, e.email, e.phone,
              e.department_id, d.department_name, e.job_title, e.hire_date,
              e.manager_id, m.full_name AS manager_name, e.status
       FROM employees e
       JOIN departments d ON d.department_id = e.department_id
       LEFT JOIN employees m ON m.employee_id = e.manager_id
       ${whereSql}
       ORDER BY e.full_name
       LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );

    const [count] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM employees e ${whereSql}`,
      params
    );
    const total = Number(count[0].total);

    res.json({ data: rows, meta: { total, page, limit, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

/* ---------- create ---------- */

export async function createEmployee(req: AuthedRequest, res: Response): Promise<void> {
  const b = req.body ?? {};
  const fullName = asText(b.fullName);
  const email = asText(b.email).toLowerCase();
  const password = typeof b.password === "string" ? b.password : "";
  const role = asText(b.role) || "Employee";
  const hireDate = asText(b.hireDate);
  const departmentId = parseInt(asText(String(b.departmentId ?? "")), 10);
  const managerId = parseInt(asText(String(b.managerId ?? "")), 10) || null;
  const phone = orNull(b.phone);
  const nationalId = orNull(b.nationalId);
  const gender = orNull(b.gender);
  const dateOfBirth = orNull(b.dateOfBirth);
  const address = orNull(b.address);
  const jobTitle = orNull(b.jobTitle);

  const errors: string[] = [];
  if (!fullName) errors.push("Full name is required.");
  if (!/^\S+@\S+\.\S+$/.test(email)) errors.push("A valid email is required.");
  if (password.length < 8) errors.push("Temporary password must be at least 8 characters.");
  if (!departmentId) errors.push("Department is required.");
  if (!DATE_RE.test(hireDate)) errors.push("Hire date is required (YYYY-MM-DD).");
  if (!CREATABLE_ROLES.includes(role)) errors.push("Role must be Employee or Manager.");
  if (gender && !GENDERS.includes(gender)) errors.push("Invalid gender.");
  if (dateOfBirth && !DATE_RE.test(dateOfBirth)) errors.push("Invalid date of birth.");
  if (phone && !/^[0-9+\-\s()]{7,30}$/.test(phone)) errors.push("Invalid phone number.");
  if (errors.length) {
    res.status(400).json({ message: errors[0], errors });
    return;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [emp] = await conn.query<ResultSetHeader>(
      `INSERT INTO employees
         (full_name, email, phone, national_id, gender, date_of_birth, address,
          department_id, job_title, hire_date, manager_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [fullName, email, phone, nationalId, gender, dateOfBirth, address,
       departmentId, jobTitle, hireDate, managerId]
    );
    const employeeId = emp.insertId;
    const code = `EMP-${String(employeeId).padStart(4, "0")}`;

    await conn.query("UPDATE employees SET employee_code = ? WHERE employee_id = ?", [code, employeeId]);

    const hash = await bcrypt.hash(password, 10);
    await conn.query(
      "INSERT INTO users (employee_id, full_name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)",
      [employeeId, fullName, email, hash, role]
    );

    // Same leave balances that register() gives a new person
    await conn.query(
      `INSERT INTO leave_balances (employee_id, leave_type_id, year, days_allocated, days_used)
       SELECT ?, leave_type_id, YEAR(CURDATE()), days_allowed_per_year, 0 FROM leave_types`,
      [employeeId]
    );

    await conn.query(
      "INSERT INTO employee_history (employee_id, change_type, new_values, changed_by) VALUES (?, 'created', ?, ?)",
      [employeeId, JSON.stringify({ fullName, email, departmentId, jobTitle, hireDate, managerId, role }), req.user?.userId ?? null]
    );

    await conn.commit();
    res.status(201).json({ message: "Employee created", employee_id: employeeId, employee_code: code });
  } catch (err) {
    await conn.rollback();
    const e = err as { code?: string; sqlMessage?: string };
    if (e.code === "ER_DUP_ENTRY") {
      const field = e.sqlMessage?.includes("national_id") ? "national ID" : "email";
      res.status(409).json({ message: `That ${field} is already registered.` });
    } else if (e.code === "ER_NO_REFERENCED_ROW_2") {
      res.status(400).json({ message: "Invalid department or manager." });
    } else {
      console.error(err);
      res.status(500).json({ message: "Database error" });
    }
  } finally {
    conn.release();
  }
}

/* ---------- view ---------- */

export async function getMyProfile(req: AuthedRequest, res: Response): Promise<void> {
  try {
    const me = await currentEmployee(req.user!.userId);
    const emp = me ? await loadEmployee(me.employee_id) : null;
    if (!emp) {
      res.status(404).json({ message: "No employee profile is linked to this account." });
      return;
    }
    res.json({ data: emp });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function getEmployee(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  if (!id) {
    res.status(400).json({ message: "Invalid employee id." });
    return;
  }

  try {
    const role = req.user!.role;
    const me = await currentEmployee(req.user!.userId);
    const emp = await loadEmployee(id);
    if (!emp) {
      res.status(404).json({ message: "Employee not found." });
      return;
    }

    const isSelf = me?.employee_id === id;
    if (role === "Employee" && !isSelf) {
      res.status(403).json({ message: "You can only view your own profile." });
      return;
    }
    if (role === "Manager" && !isSelf) {
      if (emp.department_id !== me?.department_id) {
        res.status(403).json({ message: "You can only view employees in your department." });
        return;
      }
      delete emp.national_id; // managers do not see these for other people
      delete emp.date_of_birth;
    }

    res.json({ data: emp });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

/* ---------- edit (HR) ---------- */

const FIELD_MAP: Record<string, string> = {
  fullName: "full_name",
  email: "email",
  phone: "phone",
  nationalId: "national_id",
  gender: "gender",
  dateOfBirth: "date_of_birth",
  address: "address",
  departmentId: "department_id",
  jobTitle: "job_title",
  hireDate: "hire_date",
  managerId: "manager_id",
};
const REQUIRED_FIELDS = ["fullName", "email", "departmentId", "hireDate"];

export async function updateEmployee(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  if (!id) {
    res.status(400).json({ message: "Invalid employee id." });
    return;
  }

  const b = req.body ?? {};
  const updates: Record<string, string | number | null> = {};
  const errors: string[] = [];

  for (const [key, column] of Object.entries(FIELD_MAP)) {
    if (b[key] === undefined) continue;
    const raw = typeof b[key] === "number" ? String(b[key]) : asText(b[key]);

    if (!raw) {
      if (REQUIRED_FIELDS.includes(key)) errors.push(`${key} cannot be empty.`);
      else updates[column] = null;
      continue;
    }

    if (key === "email") {
      if (!/^\S+@\S+\.\S+$/.test(raw)) errors.push("A valid email is required.");
      updates[column] = raw.toLowerCase();
    } else if (key === "departmentId" || key === "managerId") {
      const n = parseInt(raw, 10);
      if (!n) errors.push(`${key} must be a valid id.`);
      else updates[column] = n;
    } else if (key === "gender") {
      if (!GENDERS.includes(raw)) errors.push("Invalid gender.");
      updates[column] = raw;
    } else if (key === "dateOfBirth" || key === "hireDate") {
      if (!DATE_RE.test(raw)) errors.push(`${key} must be YYYY-MM-DD.`);
      updates[column] = raw;
    } else if (key === "phone") {
      if (!/^[0-9+\-\s()]{7,30}$/.test(raw)) errors.push("Invalid phone number.");
      updates[column] = raw;
    } else {
      updates[column] = raw;
    }
  }

  if (errors.length) {
    res.status(400).json({ message: errors[0], errors });
    return;
  }
  if (!Object.keys(updates).length) {
    res.status(400).json({ message: "Nothing to update." });
    return;
  }
  if (updates.manager_id === id) {
    res.status(400).json({ message: "An employee cannot be their own manager." });
    return;
  }

  const conn = await pool.getConnection();
  try {
    const [found] = await conn.query<RowDataPacket[]>(
      "SELECT * FROM employees WHERE employee_id = ?",
      [id]
    );
    const before = found[0];
    if (!before) {
      res.status(404).json({ message: "Employee not found." });
      return;
    }

    // Keep only the fields that really changed
    const oldV: Record<string, unknown> = {};
    const newV: Record<string, string | number | null> = {};
    for (const [col, val] of Object.entries(updates)) {
      if (String(before[col] ?? "") !== String(val ?? "")) {
        oldV[col] = before[col] ?? null;
        newV[col] = val;
      }
    }
    const changed = Object.keys(newV);
    if (!changed.length) {
      res.json({ message: "No changes", changed: [] });
      return;
    }

    await conn.beginTransaction();

    await conn.query(
      `UPDATE employees SET ${changed.map((c) => `${c} = ?`).join(", ")} WHERE employee_id = ?`,
      [...changed.map((c) => newV[c]), id]
    );

    // Keep the login record in step with the employee record
    const userCols = changed.filter((c) => c === "full_name" || c === "email");
    if (userCols.length) {
      await conn.query(
        `UPDATE users SET ${userCols.map((c) => `${c} = ?`).join(", ")} WHERE employee_id = ?`,
        [...userCols.map((c) => newV[c]), id]
      );
    }

    await conn.query(
      "INSERT INTO employee_history (employee_id, change_type, old_values, new_values, changed_by) VALUES (?, 'updated', ?, ?, ?)",
      [id, JSON.stringify(oldV), JSON.stringify(newV), req.user?.userId ?? null]
    );

    await conn.commit();
    res.json({ message: "Employee updated", changed });
  } catch (err) {
    await conn.rollback();
    const e = err as { code?: string; sqlMessage?: string };
    if (e.code === "ER_DUP_ENTRY") {
      const field = e.sqlMessage?.includes("national_id") ? "national ID" : "email";
      res.status(409).json({ message: `That ${field} is already used by another employee.` });
    } else if (e.code === "ER_NO_REFERENCED_ROW_2") {
      res.status(400).json({ message: "Invalid department or manager." });
    } else {
      console.error(err);
      res.status(500).json({ message: "Database error" });
    }
  } finally {
    conn.release();
  }
}

/* ---------- status (HR) ---------- */

export async function changeEmployeeStatus(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  const status = asText(req.body?.status);
  const reason = asText(req.body?.reason);

  if (!id) {
    res.status(400).json({ message: "Invalid employee id." });
    return;
  }
  if (!STATUSES.includes(status)) {
    res.status(400).json({ message: "Status must be Active, Inactive or Terminated." });
    return;
  }
  if (status !== "Active" && !reason) {
    res.status(400).json({ message: "A reason is required." });
    return;
  }
  if (reason.length > 255) {
    res.status(400).json({ message: "Reason must be 255 characters or fewer." });
    return;
  }

  const conn = await pool.getConnection();
  try {
    const me = await currentEmployee(req.user!.userId);
    if (me?.employee_id === id && status !== "Active") {
      res.status(400).json({ message: "You cannot deactivate your own account." });
      return;
    }

    const [found] = await conn.query<RowDataPacket[]>(
      `SELECT e.status, u.role
       FROM employees e LEFT JOIN users u ON u.employee_id = e.employee_id
       WHERE e.employee_id = ?`,
      [id]
    );
    const before = found[0];
    if (!before) {
      res.status(404).json({ message: "Employee not found." });
      return;
    }
    if (before.status === status) {
      res.json({ message: "No changes", status });
      return;
    }

    // Never leave the system without an active HR account
    if (before.role === "HR" && before.status === "Active" && status !== "Active") {
      const [others] = await conn.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS total
         FROM users u JOIN employees e ON e.employee_id = u.employee_id
         WHERE u.role = 'HR' AND e.status = 'Active' AND e.employee_id <> ?`,
        [id]
      );
      if (Number(others[0].total) === 0) {
        res.status(400).json({ message: "You cannot deactivate the last active HR account." });
        return;
      }
    }

    await conn.beginTransaction();
    await conn.query(
      "UPDATE employees SET status = ?, status_reason = ? WHERE employee_id = ?",
      [status, status === "Active" ? null : reason, id]
    );
    await conn.query(
      "INSERT INTO employee_history (employee_id, change_type, old_values, new_values, changed_by) VALUES (?, 'status_changed', ?, ?, ?)",
      [
        id,
        JSON.stringify({ status: before.status }),
        JSON.stringify({ status, reason: status === "Active" ? null : reason }),
        req.user?.userId ?? null,
      ]
    );
    await conn.commit();
    res.json({ message: `Employee is now ${status}`, status });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: "Database error" });
  } finally {
    conn.release();
  }
}

/* ---------- history (HR) ---------- */

const HISTORY_LABELS: Record<string, string> = {
  full_name: "Full name",
  email: "Email",
  phone: "Phone",
  national_id: "National ID",
  gender: "Gender",
  date_of_birth: "Date of birth",
  address: "Address",
  department_id: "Department",
  job_title: "Job title",
  hire_date: "Hire date",
  manager_id: "Manager",
  status: "Status",
  reason: "Reason",
  role: "Login role",
};

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function getEmployeeHistory(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  if (!id) {
    res.status(400).json({ message: "Invalid employee id." });
    return;
  }

  try {
    const [exists] = await pool.query<RowDataPacket[]>(
      "SELECT employee_id FROM employees WHERE employee_id = ?",
      [id]
    );
    if (!exists[0]) {
      res.status(404).json({ message: "Employee not found." });
      return;
    }

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT h.id, h.change_type, h.old_values, h.new_values, h.changed_at,
              u.full_name AS changed_by_name
       FROM employee_history h
       LEFT JOIN users u ON u.user_id = h.changed_by
       WHERE h.employee_id = ?
       ORDER BY h.changed_at DESC, h.id DESC`,
      [id]
    );

    const parsed = rows.map((r) => ({
      row: r,
      oldV: parseJson(r.old_values),
      newV: parseJson(r.new_values),
    }));

    // Look up names so the history shows "IT" and a person's name, not 3 and 1
    const managerIds = new Set<number>();
    for (const p of parsed) {
      for (const v of [p.oldV.manager_id, p.newV.manager_id]) {
        const n = Number(v);
        if (n) managerIds.add(n);
      }
    }
    const managerNames = new Map<number, string>();
    if (managerIds.size) {
      const [emps] = await pool.query<RowDataPacket[]>(
        "SELECT employee_id, full_name FROM employees WHERE employee_id IN (?)",
        [[...managerIds]]
      );
      for (const e of emps) managerNames.set(e.employee_id, e.full_name);
    }
    const departmentNames = new Map<number, string>();
    const [deptRows] = await pool.query<RowDataPacket[]>(
      "SELECT department_id, department_name FROM departments"
    );
    for (const d of deptRows) departmentNames.set(d.department_id, d.department_name);

    const show = (key: string, value: unknown): string => {
      if (value === null || value === undefined || value === "") return "(empty)";
      if (key === "department_id") return departmentNames.get(Number(value)) ?? String(value);
      if (key === "manager_id") return managerNames.get(Number(value)) ?? String(value);
      return String(value);
    };

    const data = parsed.map(({ row, oldV, newV }) => ({
      id: row.id,
      change_type: row.change_type,
      changed_at: row.changed_at,
      changed_by: row.changed_by_name ?? "Unknown",
      changes:
        row.change_type === "created"
          ? []
          : Object.keys(newV).map((key) => ({
              field: HISTORY_LABELS[key] ?? key,
              from: show(key, oldV[key]),
              to: show(key, newV[key]),
            })),
    }));

    res.json({ data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

/* ---------- self-edit (any logged-in employee) ---------- */

export async function updateMyProfile(req: AuthedRequest, res: Response): Promise<void> {
  const b = req.body ?? {};
  const updates: Record<string, string | null> = {};

  if (b.phone !== undefined) {
    const phone = asText(b.phone);
    if (phone && !/^[0-9+\-\s()]{7,30}$/.test(phone)) {
      res.status(400).json({ message: "Invalid phone number." });
      return;
    }
    updates.phone = phone || null;
  }
  if (b.address !== undefined) {
    const address = asText(b.address);
    if (address.length > 255) {
      res.status(400).json({ message: "Address must be 255 characters or fewer." });
      return;
    }
    updates.address = address || null;
  }
  if (!Object.keys(updates).length) {
    res.status(400).json({ message: "Nothing to update." });
    return;
  }

  const conn = await pool.getConnection();
  try {
    const me = await currentEmployee(req.user!.userId);
    if (!me) {
      res.status(404).json({ message: "No employee profile is linked to this account." });
      return;
    }

    const [found] = await conn.query<RowDataPacket[]>(
      "SELECT phone, address FROM employees WHERE employee_id = ?",
      [me.employee_id]
    );
    const before = found[0];

    const oldV: Record<string, unknown> = {};
    const newV: Record<string, string | null> = {};
    for (const [col, val] of Object.entries(updates)) {
      if (String(before[col] ?? "") !== String(val ?? "")) {
        oldV[col] = before[col] ?? null;
        newV[col] = val;
      }
    }
    const changed = Object.keys(newV);
    if (!changed.length) {
      res.json({ message: "No changes", changed: [] });
      return;
    }

    await conn.beginTransaction();
    await conn.query(
      `UPDATE employees SET ${changed.map((c) => `${c} = ?`).join(", ")} WHERE employee_id = ?`,
      [...changed.map((c) => newV[c]), me.employee_id]
    );
    await conn.query(
      "INSERT INTO employee_history (employee_id, change_type, old_values, new_values, changed_by) VALUES (?, 'updated', ?, ?, ?)",
      [me.employee_id, JSON.stringify(oldV), JSON.stringify(newV), req.user!.userId]
    );
    await conn.commit();
    res.json({ message: "Your details were updated", changed });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: "Database error" });
  } finally {
    conn.release();
  }
}
/* ---------- role change and password reset (HR) ---------- */

const MANAGED_ROLES = ["Employee", "Manager"];

async function findManagedLogin(
  employeeId: number
): Promise<{ error?: { status: number; message: string }; role?: string }> {
  const [found] = await pool.query<RowDataPacket[]>(
    "SELECT role FROM users WHERE employee_id = ?",
    [employeeId]
  );
  const target = found[0];
  if (!target) {
    return { error: { status: 404, message: "This employee has no login account." } };
  }
  if (!MANAGED_ROLES.includes(target.role)) {
    return {
      error: {
        status: 403,
        message: "HR and Chief accounts cannot be changed here.",
      },
    };
  }
  return { role: target.role as string };
}

export async function changeEmployeeRole(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  const role = asText(req.body?.role);

  if (!id) {
    res.status(400).json({ message: "Invalid employee id." });
    return;
  }
  if (!MANAGED_ROLES.includes(role)) {
    res.status(400).json({
      message: "Role must be Employee or Manager. HR and Chief accounts use a registration code.",
    });
    return;
  }

  const conn = await pool.getConnection();
  try {
    const target = await findManagedLogin(id);
    if (target.error) {
      res.status(target.error.status).json({ message: target.error.message });
      return;
    }
    if (target.role === role) {
      res.json({ message: "No changes", role });
      return;
    }

    await conn.beginTransaction();
    await conn.query("UPDATE users SET role = ? WHERE employee_id = ?", [role, id]);
    await conn.query(
      "INSERT INTO employee_history (employee_id, change_type, old_values, new_values, changed_by) VALUES (?, 'role_changed', ?, ?, ?)",
      [id, JSON.stringify({ role: target.role }), JSON.stringify({ role }), req.user?.userId ?? null]
    );
    await conn.commit();
    res.json({ message: `Login role is now ${role}`, role });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: "Database error" });
  } finally {
    conn.release();
  }
}

export async function resetEmployeePassword(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  const password = typeof req.body?.password === "string" ? req.body.password : "";

  if (!id) {
    res.status(400).json({ message: "Invalid employee id." });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ message: "The new password must be at least 8 characters." });
    return;
  }
  if (password.length > 72) {
    res.status(400).json({ message: "The new password must be 72 characters or fewer." });
    return;
  }

  const conn = await pool.getConnection();
  try {
    const target = await findManagedLogin(id);
    if (target.error) {
      res.status(target.error.status).json({ message: target.error.message });
      return;
    }

    const hash = await bcrypt.hash(password, 10);

    await conn.beginTransaction();
    await conn.query("UPDATE users SET password_hash = ? WHERE employee_id = ?", [hash, id]);
    await conn.query(
      "INSERT INTO employee_history (employee_id, change_type, old_values, new_values, changed_by) VALUES (?, 'password_reset', NULL, NULL, ?)",
      [id, req.user?.userId ?? null]
    );
    await conn.commit();
    res.json({ message: "Password reset. Share the new password with the employee yourself." });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: "Database error" });
  } finally {
    conn.release();
  }
}
/* ---------- change my own password (any logged-in user) ---------- */

export async function changeMyPassword(req: AuthedRequest, res: Response): Promise<void> {
  const current = typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
  const next = typeof req.body?.newPassword === "string" ? req.body.newPassword : "";

  if (!current || !next) {
    res.status(400).json({ message: "Enter your current password and a new password." });
    return;
  }
  if (next.length < 8) {
    res.status(400).json({ message: "The new password must be at least 8 characters." });
    return;
  }
  if (next.length > 72) {
    res.status(400).json({ message: "The new password must be 72 characters or fewer." });
    return;
  }
  if (next === current) {
    res.status(400).json({ message: "The new password must be different from the current one." });
    return;
  }

  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query<RowDataPacket[]>(
      "SELECT employee_id, password_hash FROM users WHERE user_id = ?",
      [req.user!.userId]
    );
    const user = rows[0];
    if (!user) {
      res.status(404).json({ message: "Account not found." });
      return;
    }

    // 400, not 401: the frontend logs people out on 401, and a typo should not do that
    const ok = await bcrypt.compare(current, user.password_hash);
    if (!ok) {
      res.status(400).json({ message: "Your current password is wrong." });
      return;
    }

    const hash = await bcrypt.hash(next, 10);

    await conn.beginTransaction();
    await conn.query("UPDATE users SET password_hash = ? WHERE user_id = ?", [hash, req.user!.userId]);
    await conn.query(
      "INSERT INTO employee_history (employee_id, change_type, old_values, new_values, changed_by) VALUES (?, 'password_changed', NULL, NULL, ?)",
      [user.employee_id, req.user!.userId]
    );
    await conn.commit();
    res.json({ message: "Your password was changed." });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: "Database error" });
  } finally {
    conn.release();
  }
}