import type { Response } from "express";
import type { RowDataPacket, ResultSetHeader } from "mysql2";
import { pool } from "../db";
import type { AuthedRequest } from "../middleware/auth";
import PDFDocument from "pdfkit";

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

// Accepts 1500, "1500" or "1500.50"; rejects anything that is not a plain number
function toMoney(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  if (typeof value === "string" && /^\d+(\.\d{1,2})?$/.test(value.trim())) return Number(value.trim());
  return null;
}

/* ---------- pay components ---------- */

export async function listComponents(req: AuthedRequest, res: Response): Promise<void> {
  const showAll = asText(req.query.all) === "1";
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT component_id, name, type, calc_type, default_value, is_active
       FROM pay_components
       ${showAll ? "" : "WHERE is_active = 1"}
       ORDER BY type, name`
    );
    res.json({ data: rows.map((r) => ({ ...r, default_value: Number(r.default_value) })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

function validateComponent(
  type: string,
  calcType: string,
  value: number | null
): string | null {
  if (!["Allowance", "Deduction"].includes(type)) return "Type must be Allowance or Deduction.";
  if (!["Fixed", "Percent"].includes(calcType)) return "Calculation must be Fixed or Percent.";
  if (value === null || value < 0) return "The default value must be a number of 0 or more.";
  if (calcType === "Percent" && value > 100) return "A percent cannot be more than 100.";
  return null;
}

export async function createComponent(req: AuthedRequest, res: Response): Promise<void> {
  const b = req.body ?? {};
  const name = asText(b.name);
  const type = asText(b.type);
  const calcType = asText(b.calcType) || "Fixed";
  const value = b.defaultValue === undefined || b.defaultValue === "" ? 0 : toMoney(b.defaultValue);

  if (!name) {
    res.status(400).json({ message: "A name is required." });
    return;
  }
  if (name.length > 100) {
    res.status(400).json({ message: "The name must be 100 characters or fewer." });
    return;
  }
  const problem = validateComponent(type, calcType, value);
  if (problem) {
    res.status(400).json({ message: problem });
    return;
  }

  try {
    const [r] = await pool.query<ResultSetHeader>(
      "INSERT INTO pay_components (name, type, calc_type, default_value) VALUES (?, ?, ?, ?)",
      [name, type, calcType, value]
    );
    res.status(201).json({ message: "Component created", component_id: r.insertId });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "ER_DUP_ENTRY") {
      res.status(409).json({ message: "A component with this name already exists." });
    } else {
      console.error(err);
      res.status(500).json({ message: "Database error" });
    }
  }
}

export async function updateComponent(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  const b = req.body ?? {};
  if (!id) {
    res.status(400).json({ message: "Invalid component id." });
    return;
  }

  try {
    const [found] = await pool.query<RowDataPacket[]>(
      "SELECT name, type, calc_type, default_value, is_active FROM pay_components WHERE component_id = ?",
      [id]
    );
    const current = found[0];
    if (!current) {
      res.status(404).json({ message: "Component not found." });
      return;
    }

    const name = b.name === undefined ? current.name : asText(b.name);
    const type = b.type === undefined ? current.type : asText(b.type);
    const calcType = b.calcType === undefined ? current.calc_type : asText(b.calcType);
    const value = b.defaultValue === undefined ? Number(current.default_value) : toMoney(b.defaultValue);
    const isActive = b.isActive === undefined ? Number(current.is_active) : b.isActive ? 1 : 0;

    if (!name || name.length > 100) {
      res.status(400).json({ message: "The name is required and must be 100 characters or fewer." });
      return;
    }
    const problem = validateComponent(type, calcType, value);
    if (problem) {
      res.status(400).json({ message: problem });
      return;
    }

    await pool.query(
      `UPDATE pay_components
       SET name = ?, type = ?, calc_type = ?, default_value = ?, is_active = ?
       WHERE component_id = ?`,
      [name, type, calcType, value, isActive, id]
    );
    res.json({ message: "Component updated" });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "ER_DUP_ENTRY") {
      res.status(409).json({ message: "A component with this name already exists." });
    } else {
      console.error(err);
      res.status(500).json({ message: "Database error" });
    }
  }
}

/* ---------- basic salary ---------- */

export async function getEmployeePayroll(req: AuthedRequest, res: Response): Promise<void> {
  const employeeId = parseInt(String(req.params.id), 10);
  if (!employeeId) {
    res.status(400).json({ message: "Invalid employee id." });
    return;
  }

  try {
    const [emp] = await pool.query<RowDataPacket[]>(
      "SELECT employee_id, full_name, employee_code FROM employees WHERE employee_id = ?",
      [employeeId]
    );
    if (!emp[0]) {
      res.status(404).json({ message: "Employee not found." });
      return;
    }

    const [salaries] = await pool.query<RowDataPacket[]>(
      `SELECT s.salary_id, s.basic_salary, s.effective_from, s.reason, u.full_name AS set_by
       FROM employee_salaries s
       LEFT JOIN users u ON u.user_id = s.created_by
       WHERE s.employee_id = ?
       ORDER BY s.effective_from DESC`,
      [employeeId]
    );

    const [components] = await pool.query<RowDataPacket[]>(
      `SELECT ec.id, ec.component_id, c.name, c.type, c.calc_type, c.default_value,
              ec.value, ec.start_date, ec.end_date
       FROM employee_components ec
       JOIN pay_components c ON c.component_id = ec.component_id
       WHERE ec.employee_id = ?
       ORDER BY c.type, c.name, ec.start_date DESC`,
      [employeeId]
    );

    const today = todayString();
    const current = salaries.find((s) => String(s.effective_from).slice(0, 10) <= today);

    res.json({
      data: {
        employee: emp[0],
        current_salary: current ? Number(current.basic_salary) : null,
        salaries: salaries.map((s) => ({ ...s, basic_salary: Number(s.basic_salary) })),
        components: components.map((c) => ({
          ...c,
          default_value: Number(c.default_value),
          value: c.value === null ? null : Number(c.value),
        })),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function setBasicSalary(req: AuthedRequest, res: Response): Promise<void> {
  const employeeId = parseInt(String(req.params.id), 10);
  const b = req.body ?? {};
  const salary = toMoney(b.basicSalary);
  const effectiveFrom = asText(b.effectiveFrom) || todayString();
  const reason = asText(b.reason) || null;

  const errors: string[] = [];
  if (!employeeId) errors.push("Invalid employee id.");
  if (salary === null || salary <= 0) errors.push("The basic salary must be a number greater than 0.");
  else if (salary > 100000000) errors.push("The basic salary is too large.");
  if (!isValidDate(effectiveFrom)) errors.push("The effective date must be YYYY-MM-DD.");
  if (reason && reason.length > 255) errors.push("The reason must be 255 characters or fewer.");
  if (errors.length) {
    res.status(400).json({ message: errors[0], errors });
    return;
  }

  const conn = await pool.getConnection();
  try {
    const [emp] = await conn.query<RowDataPacket[]>(
      "SELECT status FROM employees WHERE employee_id = ?",
      [employeeId]
    );
    if (!emp[0]) {
      res.status(404).json({ message: "Employee not found." });
      return;
    }
    if (emp[0].status !== "Active") {
      res.status(400).json({ message: "Salaries can only be set for active employees." });
      return;
    }

    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO employee_salaries (employee_id, basic_salary, effective_from, reason, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [employeeId, salary, effectiveFrom, reason, req.user?.userId ?? null]
    );
    // The amount is stored in the payroll tables only, so the general history records the event, not the figure
    await conn.query(
      `INSERT INTO employee_history (employee_id, change_type, old_values, new_values, changed_by)
       VALUES (?, 'salary_set', NULL, ?, ?)`,
      [employeeId, JSON.stringify({ effective_from: effectiveFrom }), req.user?.userId ?? null]
    );
    await conn.commit();
    res.status(201).json({ message: "Basic salary saved" });
  } catch (err) {
    await conn.rollback();
    const e = err as { code?: string };
    if (e.code === "ER_DUP_ENTRY") {
      res.status(409).json({ message: "A salary starting on this date already exists for this employee." });
    } else {
      console.error(err);
      res.status(500).json({ message: "Database error" });
    }
  } finally {
    conn.release();
  }
}

/* ---------- components assigned to an employee ---------- */

export async function assignComponent(req: AuthedRequest, res: Response): Promise<void> {
  const employeeId = parseInt(String(req.params.id), 10);
  const b = req.body ?? {};
  const componentId = parseInt(asText(String(b.componentId ?? "")), 10);
  const startDate = asText(b.startDate) || todayString();
  const endDate = asText(b.endDate) || null;
  const hasValue = b.value !== undefined && b.value !== null && b.value !== "";
  const value = hasValue ? toMoney(b.value) : null;

  const errors: string[] = [];
  if (!employeeId) errors.push("Invalid employee id.");
  if (!componentId) errors.push("Choose a component.");
  if (!isValidDate(startDate)) errors.push("The start date must be YYYY-MM-DD.");
  if (endDate && !isValidDate(endDate)) errors.push("The end date must be YYYY-MM-DD.");
  if (endDate && isValidDate(startDate) && endDate < startDate) {
    errors.push("The end date cannot be before the start date.");
  }
  if (hasValue && (value === null || value < 0)) errors.push("The value must be a number of 0 or more.");
  if (errors.length) {
    res.status(400).json({ message: errors[0], errors });
    return;
  }

  const conn = await pool.getConnection();
  try {
    const [emp] = await conn.query<RowDataPacket[]>(
      "SELECT status FROM employees WHERE employee_id = ?",
      [employeeId]
    );
    if (!emp[0]) {
      res.status(404).json({ message: "Employee not found." });
      return;
    }
    if (emp[0].status !== "Active") {
      res.status(400).json({ message: "Components can only be assigned to active employees." });
      return;
    }

    const [comp] = await conn.query<RowDataPacket[]>(
      "SELECT name, calc_type, is_active FROM pay_components WHERE component_id = ?",
      [componentId]
    );
    if (!comp[0]) {
      res.status(404).json({ message: "Component not found." });
      return;
    }
    if (!Number(comp[0].is_active)) {
      res.status(400).json({ message: "This component is no longer active." });
      return;
    }
    if (value !== null && comp[0].calc_type === "Percent" && value > 100) {
      res.status(400).json({ message: "A percent cannot be more than 100." });
      return;
    }

    // The same component cannot overlap itself for one employee
    const [overlap] = await conn.query<RowDataPacket[]>(
      `SELECT id FROM employee_components
       WHERE employee_id = ? AND component_id = ?
         AND (end_date IS NULL OR end_date >= ?)
         AND (? IS NULL OR start_date <= ?)`,
      [employeeId, componentId, startDate, endDate, endDate]
    );
    if (overlap[0]) {
      res.status(409).json({
        message: "This component is already assigned for those dates. End the existing one first.",
      });
      return;
    }

    await conn.beginTransaction();
    const [ins] = await conn.query<ResultSetHeader>(
      `INSERT INTO employee_components (employee_id, component_id, value, start_date, end_date, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [employeeId, componentId, value, startDate, endDate, req.user?.userId ?? null]
    );
    await conn.query(
      `INSERT INTO employee_history (employee_id, change_type, old_values, new_values, changed_by)
       VALUES (?, 'component_assigned', NULL, ?, ?)`,
      [employeeId, JSON.stringify({ component: comp[0].name, start_date: startDate }), req.user?.userId ?? null]
    );
    await conn.commit();
    res.status(201).json({ message: "Component assigned", id: ins.insertId });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: "Database error" });
  } finally {
    conn.release();
  }
}

export async function endAssignment(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  const endDate = asText(req.body?.endDate) || todayString();

  if (!id) {
    res.status(400).json({ message: "Invalid assignment id." });
    return;
  }
  if (!isValidDate(endDate)) {
    res.status(400).json({ message: "The end date must be YYYY-MM-DD." });
    return;
  }

  const conn = await pool.getConnection();
  try {
    const [found] = await conn.query<RowDataPacket[]>(
      `SELECT ec.employee_id, ec.start_date, c.name
       FROM employee_components ec JOIN pay_components c ON c.component_id = ec.component_id
       WHERE ec.id = ?`,
      [id]
    );
    const row = found[0];
    if (!row) {
      res.status(404).json({ message: "Assignment not found." });
      return;
    }
    if (endDate < String(row.start_date).slice(0, 10)) {
      res.status(400).json({ message: "The end date cannot be before the start date." });
      return;
    }

    await conn.beginTransaction();
    await conn.query("UPDATE employee_components SET end_date = ? WHERE id = ?", [endDate, id]);
    await conn.query(
      `INSERT INTO employee_history (employee_id, change_type, old_values, new_values, changed_by)
       VALUES (?, 'component_ended', NULL, ?, ?)`,
      [row.employee_id, JSON.stringify({ component: row.name, end_date: endDate }), req.user?.userId ?? null]
    );
    await conn.commit();
    res.json({ message: "Component ended", end_date: endDate });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: "Database error" });
  } finally {
    conn.release();
  }
}
/* ---------- monthly payroll runs ---------- */

const round2 = (n: number) => Math.round(n * 100) / 100;

function monthBounds(year: number, month: number): { first: string; last: string } {
  const p = (n: number) => String(n).padStart(2, "0");
  const lastDay = new Date(year, month, 0).getDate();
  return { first: `${year}-${p(month)}-01`, last: `${year}-${p(month)}-${p(lastDay)}` };
}

export async function listRuns(_req: AuthedRequest, res: Response): Promise<void> {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT r.run_id, r.period_year, r.period_month, r.status, r.employee_count,
              r.total_gross, r.total_deductions, r.total_net, r.approved_at,
              c.full_name AS created_by_name, a.full_name AS approved_by_name, r.paid_at, pd.full_name AS paid_by_name
       FROM payroll_runs r
       LEFT JOIN users c ON c.user_id = r.created_by
       LEFT JOIN users a ON a.user_id = r.approved_by
       LEFT JOIN users pd ON pd.user_id = r.paid_by
       ORDER BY r.period_year DESC, r.period_month DESC`
    );
    res.json({
      data: rows.map((r) => ({
        ...r,
        total_gross: Number(r.total_gross),
        total_deductions: Number(r.total_deductions),
        total_net: Number(r.total_net),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function createRun(req: AuthedRequest, res: Response): Promise<void> {
  const year = Number(req.body?.year);
  const month = Number(req.body?.month);
  const now = new Date();

  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    res.status(400).json({ message: "Enter a valid year." });
    return;
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    res.status(400).json({ message: "The month must be from 1 to 12." });
    return;
  }
  if (year * 12 + month > now.getFullYear() * 12 + (now.getMonth() + 1)) {
    res.status(400).json({ message: "You cannot run payroll for a future month." });
    return;
  }

  try {
    const [r] = await pool.query<ResultSetHeader>(
      "INSERT INTO payroll_runs (period_year, period_month, created_by) VALUES (?, ?, ?)",
      [year, month, req.user?.userId ?? null]
    );
    res.status(201).json({ message: "Payroll run created. Calculate it to generate payslips.", run_id: r.insertId });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "ER_DUP_ENTRY") {
      res.status(409).json({ message: "A payroll run for this month already exists." });
    } else {
      console.error(err);
      res.status(500).json({ message: "Database error" });
    }
  }
}

export async function calculateRun(req: AuthedRequest, res: Response): Promise<void> {
  const runId = parseInt(String(req.params.id), 10);
  if (!runId) {
    res.status(400).json({ message: "Invalid run id." });
    return;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [runRows] = await conn.query<RowDataPacket[]>(
      "SELECT run_id, period_year, period_month, status FROM payroll_runs WHERE run_id = ? FOR UPDATE",
      [runId]
    );
    const run = runRows[0];
    if (!run) throw Object.assign(new Error("Payroll run not found."), { status: 404 });
    if (run.status !== "Draft") {
      throw Object.assign(new Error("An approved payroll run cannot be recalculated."), { status: 400 });
    }

    const { first, last } = monthBounds(Number(run.period_year), Number(run.period_month));

    // Active employees, with the salary that applies on the last day of the month
    const [people] = await conn.query<RowDataPacket[]>(
      `SELECT e.employee_id, e.full_name, e.employee_code, e.job_title, d.department_name,
              (SELECT s.basic_salary FROM employee_salaries s
                 WHERE s.employee_id = e.employee_id AND s.effective_from <= ?
                 ORDER BY s.effective_from DESC LIMIT 1) AS basic_salary
       FROM employees e
       JOIN departments d ON d.department_id = e.department_id
       WHERE e.status = 'Active' AND e.hire_date <= ?
       ORDER BY e.full_name`,
      [last, last]
    );

    const [assigned] = await conn.query<RowDataPacket[]>(
      `SELECT ec.employee_id, c.name, c.type, c.calc_type,
              COALESCE(ec.value, c.default_value) AS rate
       FROM employee_components ec
       JOIN pay_components c ON c.component_id = ec.component_id
       WHERE c.is_active = 1 AND ec.start_date <= ? AND (ec.end_date IS NULL OR ec.end_date >= ?)`,
      [last, first]
    );
    const byEmployee = new Map<number, RowDataPacket[]>();
    for (const a of assigned) {
      const list = byEmployee.get(a.employee_id) ?? [];
      list.push(a);
      byEmployee.set(a.employee_id, list);
    }

    type Slip = {
      emp: RowDataPacket;
      basic: number;
      allowances: number;
      deductions: number;
      gross: number;
      net: number;
      items: { name: string; type: string; calc: string; rate: number; amount: number }[];
    };
    const slips: Slip[] = [];
    const skipped: string[] = [];

    for (const p of people) {
      if (p.basic_salary === null || p.basic_salary === undefined) {
        skipped.push(`${p.full_name} (${p.employee_code ?? "no code"})`);
        continue;
      }
      const basic = Number(p.basic_salary);
      const items: Slip["items"] = [];
      let allowances = 0;
      let deductions = 0;

      for (const a of byEmployee.get(p.employee_id) ?? []) {
        const rate = Number(a.rate);
        const amount = round2(a.calc_type === "Percent" ? (basic * rate) / 100 : rate);
        items.push({ name: a.name, type: a.type, calc: a.calc_type, rate, amount });
        if (a.type === "Allowance") allowances += amount;
        else deductions += amount;
      }

      const gross = round2(basic + allowances);
      const net = round2(gross - deductions);
      if (net < 0) {
        throw Object.assign(
          new Error(`${p.full_name}: deductions are more than the gross pay. Fix the components, then calculate again.`),
          { status: 400 }
        );
      }
      slips.push({ emp: p, basic, allowances: round2(allowances), deductions: round2(deductions), gross, net, items });
    }

    // Recalculating replaces the draft's payslips (their lines are removed with them)
    await conn.query("DELETE FROM payslips WHERE run_id = ?", [runId]);

    let totalGross = 0;
    let totalDeductions = 0;
    let totalNet = 0;

    for (const s of slips) {
      const [ins] = await conn.query<ResultSetHeader>(
        `INSERT INTO payslips
           (run_id, employee_id, employee_name, employee_code, department_name, job_title,
            basic_salary, total_allowances, gross_pay, total_deductions, net_pay)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [runId, s.emp.employee_id, s.emp.full_name, s.emp.employee_code, s.emp.department_name,
         s.emp.job_title, s.basic, s.allowances, s.gross, s.deductions, s.net]
      );
      for (const it of s.items) {
        await conn.query(
          `INSERT INTO payslip_items (payslip_id, component_name, type, calc_type, rate, amount)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [ins.insertId, it.name, it.type, it.calc, it.rate, it.amount]
        );
      }
      totalGross += s.gross;
      totalDeductions += s.deductions;
      totalNet += s.net;
    }

    await conn.query(
      `UPDATE payroll_runs
       SET employee_count = ?, total_gross = ?, total_deductions = ?, total_net = ?
       WHERE run_id = ?`,
      [slips.length, round2(totalGross), round2(totalDeductions), round2(totalNet), runId]
    );

    await conn.commit();
    res.json({
      message: `Calculated ${slips.length} payslip(s).`,
      employee_count: slips.length,
      total_gross: round2(totalGross),
      total_deductions: round2(totalDeductions),
      total_net: round2(totalNet),
      skipped_no_salary: skipped,
    });
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

export async function getRun(req: AuthedRequest, res: Response): Promise<void> {
  const runId = parseInt(String(req.params.id), 10);
  if (!runId) {
    res.status(400).json({ message: "Invalid run id." });
    return;
  }

  try {
    const [runRows] = await pool.query<RowDataPacket[]>(
      `SELECT r.run_id, r.period_year, r.period_month, r.status, r.employee_count,
              r.total_gross, r.total_deductions, r.total_net, r.approved_at,
              c.full_name AS created_by_name, a.full_name AS approved_by_name, r.paid_at, pd.full_name AS paid_by_name
       FROM payroll_runs r
       LEFT JOIN users c ON c.user_id = r.created_by
       LEFT JOIN users a ON a.user_id = r.approved_by
       LEFT JOIN users pd ON pd.user_id = r.paid_by
       WHERE r.run_id = ?`,
      [runId]
    );
    const run = runRows[0];
    if (!run) {
      res.status(404).json({ message: "Payroll run not found." });
      return;
    }

    const [slips] = await pool.query<RowDataPacket[]>(
      `SELECT payslip_id, employee_id, employee_name, employee_code, department_name, job_title,
              basic_salary, total_allowances, gross_pay, total_deductions, net_pay
       FROM payslips WHERE run_id = ? ORDER BY employee_name`,
      [runId]
    );

    // Active employees who would be left out of this month because they have no salary yet
    let skipped: RowDataPacket[] = [];
    if (run.status === "Draft") {
      const { last } = monthBounds(Number(run.period_year), Number(run.period_month));
      const [s] = await pool.query<RowDataPacket[]>(
        `SELECT e.employee_id, e.full_name, e.employee_code
         FROM employees e
         WHERE e.status = 'Active' AND e.hire_date <= ?
           AND NOT EXISTS (SELECT 1 FROM employee_salaries s
                           WHERE s.employee_id = e.employee_id AND s.effective_from <= ?)
         ORDER BY e.full_name`,
        [last, last]
      );
      skipped = s;
    }

    res.json({
      data: {
        ...run,
        total_gross: Number(run.total_gross),
        total_deductions: Number(run.total_deductions),
        total_net: Number(run.total_net),
        skipped,
        payslips: slips.map((s) => ({
          ...s,
          basic_salary: Number(s.basic_salary),
          total_allowances: Number(s.total_allowances),
          gross_pay: Number(s.gross_pay),
          total_deductions: Number(s.total_deductions),
          net_pay: Number(s.net_pay),
        })),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}
export async function approveRun(req: AuthedRequest, res: Response): Promise<void> {
  const runId = parseInt(String(req.params.id), 10);
  if (!runId) {
    res.status(400).json({ message: "Invalid run id." });
    return;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [runRows] = await conn.query<RowDataPacket[]>(
      "SELECT status, employee_count FROM payroll_runs WHERE run_id = ? FOR UPDATE",
      [runId]
    );
    const run = runRows[0];
    if (!run) throw Object.assign(new Error("Payroll run not found."), { status: 404 });
    if (run.status === "Approved") throw Object.assign(new Error("This run is already approved."), { status: 409 });
    if (!Number(run.employee_count)) {
      throw Object.assign(new Error("Calculate the run first. It has no payslips to approve."), { status: 400 });
    }

    await conn.query(
      "UPDATE payroll_runs SET status = 'Approved', approved_by = ?, approved_at = NOW() WHERE run_id = ?",
      [req.user?.userId ?? null, runId]
    );
    await conn.commit();
    res.json({ message: "Payroll approved. Employees can now see their payslips." });
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

export async function deleteRun(req: AuthedRequest, res: Response): Promise<void> {
  const runId = parseInt(String(req.params.id), 10);
  if (!runId) {
    res.status(400).json({ message: "Invalid run id." });
    return;
  }

  try {
    const [found] = await pool.query<RowDataPacket[]>(
      "SELECT status FROM payroll_runs WHERE run_id = ?",
      [runId]
    );
    if (!found[0]) {
      res.status(404).json({ message: "Payroll run not found." });
      return;
    }
    if (found[0].status !== "Draft") {
      res.status(400).json({ message: "An approved payroll run cannot be deleted." });
      return;
    }
    await pool.query("DELETE FROM payroll_runs WHERE run_id = ? AND status = 'Draft'", [runId]);
    res.json({ message: "Draft payroll run deleted." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}
/* ---------- payslips ---------- */

// The employee behind the logged-in account
async function myEmployeeId(userId: number): Promise<number | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT employee_id FROM users WHERE user_id = ?",
    [userId]
  );
  return rows[0]?.employee_id ?? null;
}

export async function listMyPayslips(req: AuthedRequest, res: Response): Promise<void> {
  try {
    const employeeId = await myEmployeeId(req.user!.userId);
    if (!employeeId) {
      res.status(404).json({ message: "No employee profile is linked to this account." });
      return;
    }

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT p.payslip_id, r.period_year, r.period_month, r.paid_at,
              p.basic_salary, p.total_allowances, p.gross_pay, p.total_deductions, p.net_pay
       FROM payslips p
       JOIN payroll_runs r ON r.run_id = p.run_id
       WHERE p.employee_id = ? AND r.status = 'Approved'
       ORDER BY r.period_year DESC, r.period_month DESC`,
      [employeeId]
    );
    res.json({
      data: rows.map((r) => ({
        ...r,
        basic_salary: Number(r.basic_salary),
        total_allowances: Number(r.total_allowances),
        gross_pay: Number(r.gross_pay),
        total_deductions: Number(r.total_deductions),
        net_pay: Number(r.net_pay),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function getPayslip(req: AuthedRequest, res: Response): Promise<void> {
  const payslipId = parseInt(String(req.params.id), 10);
  if (!payslipId) {
    res.status(400).json({ message: "Invalid payslip id." });
    return;
  }

  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT p.payslip_id, p.employee_id, p.employee_name, p.employee_code, p.department_name,
              p.job_title, p.basic_salary, p.total_allowances, p.gross_pay, p.total_deductions,
              p.net_pay, r.period_year, r.period_month, r.status, r.approved_at, r.paid_at
       FROM payslips p JOIN payroll_runs r ON r.run_id = p.run_id
       WHERE p.payslip_id = ?`,
      [payslipId]
    );
    const slip = rows[0];

    // The same message for "does not exist" and "belongs to someone else", so ids cannot be probed
    const notFound = () => res.status(404).json({ message: "Payslip not found." });
    if (!slip) {
      notFound();
      return;
    }

    if (req.user!.role !== "HR") {
      const me = await myEmployeeId(req.user!.userId);
      if (!me || me !== slip.employee_id || slip.status !== "Approved") {
        notFound();
        return;
      }
    }

    const [items] = await pool.query<RowDataPacket[]>(
      `SELECT component_name, type, calc_type, rate, amount
       FROM payslip_items WHERE payslip_id = ? ORDER BY type, component_name`,
      [payslipId]
    );

    res.json({
      data: {
        ...slip,
        basic_salary: Number(slip.basic_salary),
        total_allowances: Number(slip.total_allowances),
        gross_pay: Number(slip.gross_pay),
        total_deductions: Number(slip.total_deductions),
        net_pay: Number(slip.net_pay),
        items: items.map((i) => ({ ...i, rate: Number(i.rate), amount: Number(i.amount) })),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}
/* ---------- salary overview (HR) ---------- */

export async function listSalaries(req: AuthedRequest, res: Response): Promise<void> {
  const page = Math.max(parseInt(asText(req.query.page), 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(asText(req.query.limit), 10) || 20, 1), 100);
  const search = asText(req.query.search);
  const missingOnly = asText(req.query.missing) === "1";

  const noSalary =
    "NOT EXISTS (SELECT 1 FROM employee_salaries s WHERE s.employee_id = e.employee_id AND s.effective_from <= CURDATE())";

  try {
    const where: string[] = ["e.status = 'Active'"];
    const params: (string | number)[] = [];
    if (search) {
      const like = `%${search}%`;
      where.push("(e.full_name LIKE ? OR e.employee_code LIKE ?)");
      params.push(like, like);
    }
    if (missingOnly) where.push(noSalary);
    const whereSql = `WHERE ${where.join(" AND ")}`;

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT e.employee_id, e.employee_code, e.full_name, d.department_name, e.job_title,
              (SELECT s.basic_salary FROM employee_salaries s
                 WHERE s.employee_id = e.employee_id AND s.effective_from <= CURDATE()
                 ORDER BY s.effective_from DESC LIMIT 1) AS basic_salary,
              (SELECT COUNT(*) FROM employee_components ec
                 JOIN pay_components c ON c.component_id = ec.component_id
                 WHERE ec.employee_id = e.employee_id AND c.is_active = 1
                   AND ec.start_date <= CURDATE()
                   AND (ec.end_date IS NULL OR ec.end_date >= CURDATE())) AS components
       FROM employees e
       JOIN departments d ON d.department_id = e.department_id
       ${whereSql}
       ORDER BY basic_salary IS NULL DESC, e.full_name
       LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );

    const [count] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM employees e ${whereSql}`,
      params
    );
    const [missing] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM employees e WHERE e.status = 'Active' AND ${noSalary}`
    );
    const total = Number(count[0].total);

    res.json({
      data: rows.map((r) => ({
        ...r,
        basic_salary: r.basic_salary === null ? null : Number(r.basic_salary),
        components: Number(r.components),
      })),
      meta: { total, page, limit, pages: Math.ceil(total / limit), missing_total: Number(missing[0].total) },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}
/* ---------- my current salary (any logged-in person, own data only) ---------- */

export async function getMySalary(req: AuthedRequest, res: Response): Promise<void> {
  try {
    const employeeId = await myEmployeeId(req.user!.userId);
    if (!employeeId) {
      res.status(404).json({ message: "No employee profile is linked to this account." });
      return;
    }

    const today = todayString();
    const [sal] = await pool.query<RowDataPacket[]>(
      `SELECT basic_salary, effective_from FROM employee_salaries
       WHERE employee_id = ? AND effective_from <= ?
       ORDER BY effective_from DESC LIMIT 1`,
      [employeeId, today]
    );
    if (!sal[0]) {
      res.json({
        data: { basic_salary: null, items: [], total_allowances: 0, total_deductions: 0, gross_pay: 0, net_pay: 0 },
      });
      return;
    }

    const basic = Number(sal[0].basic_salary);
    const [comps] = await pool.query<RowDataPacket[]>(
      `SELECT c.name, c.type, c.calc_type, COALESCE(ec.value, c.default_value) AS rate
       FROM employee_components ec
       JOIN pay_components c ON c.component_id = ec.component_id
       WHERE ec.employee_id = ? AND c.is_active = 1
         AND ec.start_date <= ? AND (ec.end_date IS NULL OR ec.end_date >= ?)
       ORDER BY c.type, c.name`,
      [employeeId, today, today]
    );

    let allowances = 0;
    let deductions = 0;
    const items = comps.map((c) => {
      const rate = Number(c.rate);
      const amount = round2(c.calc_type === "Percent" ? (basic * rate) / 100 : rate);
      if (c.type === "Allowance") allowances += amount;
      else deductions += amount;
      return { name: c.name, type: c.type, calc_type: c.calc_type, rate, amount };
    });

    const gross = round2(basic + allowances);
    res.json({
      data: {
        basic_salary: basic,
        effective_from: String(sal[0].effective_from).slice(0, 10),
        items,
        total_allowances: round2(allowances),
        total_deductions: round2(deductions),
        gross_pay: gross,
        net_pay: round2(gross - deductions),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

/* ---------- mark an approved month as paid (HR) ---------- */

export async function markRunPaid(req: AuthedRequest, res: Response): Promise<void> {
  const runId = parseInt(String(req.params.id), 10);
  if (!runId) {
    res.status(400).json({ message: "Invalid run id." });
    return;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [found] = await conn.query<RowDataPacket[]>(
      "SELECT status, paid_at FROM payroll_runs WHERE run_id = ? FOR UPDATE",
      [runId]
    );
    const run = found[0];
    if (!run) throw Object.assign(new Error("Payroll run not found."), { status: 404 });
    if (run.status !== "Approved") {
      throw Object.assign(new Error("Only an approved payroll run can be marked as paid."), { status: 400 });
    }
    if (run.paid_at) throw Object.assign(new Error("This run is already marked as paid."), { status: 409 });

    await conn.query("UPDATE payroll_runs SET paid_at = NOW(), paid_by = ? WHERE run_id = ?", [
      req.user?.userId ?? null,
      runId,
    ]);
    await conn.commit();
    res.json({ message: "Payroll marked as paid. Employees now see their payslips as paid." });
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
/* ---------- export an approved month (HR) ---------- */

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  // A leading = + - @ would be run as a formula by Excel
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return `"${text.replace(/"/g, '""')}"`;
}

const fixed = (n: number) => Number(n).toFixed(2);
const pretty = (n: number) =>
  Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function exportRun(req: AuthedRequest, res: Response): Promise<void> {
  const runId = parseInt(String(req.params.id), 10);
  const format = asText(req.query.format).toLowerCase() || "csv";

  if (!runId) {
    res.status(400).json({ message: "Invalid run id." });
    return;
  }
  if (format !== "csv" && format !== "pdf") {
    res.status(400).json({ message: "The format must be csv or pdf." });
    return;
  }

  let run: RowDataPacket;
  let slips: RowDataPacket[];
  let generatedBy = "";

  try {
    const [runRows] = await pool.query<RowDataPacket[]>(
      `SELECT r.run_id, r.period_year, r.period_month, r.status, r.employee_count,
              r.total_gross, r.total_deductions, r.total_net, r.approved_at, r.paid_at,
              a.full_name AS approved_by_name
       FROM payroll_runs r
       LEFT JOIN users a ON a.user_id = r.approved_by
       WHERE r.run_id = ?`,
      [runId]
    );
    if (!runRows[0]) {
      res.status(404).json({ message: "Payroll run not found." });
      return;
    }
    run = runRows[0];
    if (run.status !== "Approved") {
      res.status(400).json({ message: "Only approved payroll runs can be exported." });
      return;
    }

    const [s] = await pool.query<RowDataPacket[]>(
      `SELECT employee_code, employee_name, department_name, job_title,
              basic_salary, total_allowances, gross_pay, total_deductions, net_pay
       FROM payslips WHERE run_id = ? ORDER BY employee_name`,
      [runId]
    );
    slips = s;

    const [u] = await pool.query<RowDataPacket[]>("SELECT full_name FROM users WHERE user_id = ?", [
      req.user!.userId,
    ]);
    generatedBy = u[0]?.full_name ?? "";
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
    return;
  }

  const monthLabel = `${MONTH_NAMES[Number(run.period_month) - 1]} ${run.period_year}`;
  const stamp = `${run.period_year}-${String(run.period_month).padStart(2, "0")}`;
  const paidText = run.paid_at ? `Paid on ${String(run.paid_at).slice(0, 16)}` : "Not marked as paid yet";

  if (format === "csv") {
    const lines: string[] = [];
    lines.push(["Payroll", monthLabel, "Status", paidText, "Generated by", generatedBy, "On", todayString()].map(csvCell).join(","));
    lines.push(
      ["Employee code", "Name", "Department", "Job title", "Basic salary", "Allowances", "Gross pay", "Deductions", "Net pay"]
        .map(csvCell)
        .join(",")
    );
    for (const p of slips) {
      lines.push(
        [
          p.employee_code, p.employee_name, p.department_name, p.job_title,
          fixed(p.basic_salary), fixed(p.total_allowances), fixed(p.gross_pay),
          fixed(p.total_deductions), fixed(p.net_pay),
        ]
          .map(csvCell)
          .join(",")
      );
    }
    lines.push(
      ["", "TOTAL", "", "", "", "", fixed(run.total_gross), fixed(run.total_deductions), fixed(run.total_net)]
        .map(csvCell)
        .join(",")
    );

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="payroll-${stamp}.csv"`);
    // The BOM makes Excel read the file as UTF-8
    res.send("\uFEFF" + lines.join("\r\n"));
    return;
  }

  // PDF
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="payroll-${stamp}.pdf"`);

  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 40 });
  doc.pipe(res);

  doc.font("Helvetica-Bold").fontSize(18).text(`Payroll report: ${monthLabel}`);
  doc.moveDown(0.3);
  doc.font("Helvetica").fontSize(10);
  doc.text(`Status: Approved${run.approved_by_name ? " by " + run.approved_by_name : ""}. ${paidText}.`);
  doc.text(`Employees: ${run.employee_count}    Generated on ${todayString()}${generatedBy ? " by " + generatedBy : ""}`);
  doc.text("Confidential: contains salary information.");

  const cols = [
    { label: "#", w: 25, right: false },
    { label: "Name", w: 150, right: false },
    { label: "Code", w: 60, right: false },
    { label: "Department", w: 100, right: false },
    { label: "Basic salary", w: 85, right: true },
    { label: "Allowances", w: 80, right: true },
    { label: "Gross pay", w: 85, right: true },
    { label: "Deductions", w: 80, right: true },
    { label: "Net pay", w: 85, right: true },
  ];
  const left = 40;
  const totalWidth = cols.reduce((sum, c) => sum + c.w, 0);
  let y = doc.y + 14;

  const drawRow = (cells: string[], bold: boolean) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9);
    let x = left;
    cells.forEach((text, i) => {
      doc.text(text, x, y, {
        width: cols[i].w - 6,
        align: cols[i].right ? "right" : "left",
        lineBreak: false,
        ellipsis: true,
      });
      x += cols[i].w;
    });
    y += 16;
  };

  const drawHeader = () => {
    drawRow(cols.map((c) => c.label), true);
    doc.moveTo(left, y - 3).lineTo(left + totalWidth, y - 3).stroke();
    y += 2;
  };

  drawHeader();
  slips.forEach((p, i) => {
    if (y > doc.page.height - 70) {
      doc.addPage();
      y = 40;
      drawHeader();
    }
    drawRow(
      [
        String(i + 1), p.employee_name, p.employee_code ?? "", p.department_name ?? "",
        pretty(p.basic_salary), pretty(p.total_allowances), pretty(p.gross_pay),
        pretty(p.total_deductions), pretty(p.net_pay),
      ],
      false
    );
  });

  if (y > doc.page.height - 70) {
    doc.addPage();
    y = 40;
  }
  doc.moveTo(left, y - 3).lineTo(left + totalWidth, y - 3).stroke();
  drawRow(
    ["", "TOTAL", "", "", "", "", pretty(run.total_gross), pretty(run.total_deductions), pretty(run.total_net)],
    true
  );

  doc.end();
}