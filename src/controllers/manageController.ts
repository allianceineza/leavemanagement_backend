import type { Request, Response } from "express";
import { pool } from "../db";
import type { RowDataPacket, ResultSetHeader } from "mysql2";

const STATUSES = ["Pending", "Approved", "Rejected", "Cancelled"];

function todayString(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function isValidDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(new Date(value + "T00:00:00").getTime())
  );
}

function safe(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Database error" });
    }
  };
}

// CSV helpers. Cells starting with = + - @ are prefixed so Excel does not run them as formulas.
function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(csvCell).join(","));
  return "\uFEFF" + lines.join("\r\n");
}

function sendCsv(res: Response, filename: string, csv: string): void {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
}

// Reads the from and to dates. Both default to today.
function parseRange(
  q: Request["query"]
): { error?: string; from: string; to: string } {
  const from = q.from ? String(q.from) : todayString();
  const to = q.to ? String(q.to) : from;

  if (!isValidDate(from) || !isValidDate(to)) {
    return { error: "Invalid date.", from, to };
  }

  if (to < from) {
    return {
      error: "The end date cannot be before the start date.",
      from,
      to,
    };
  }

  return { from, to };
}

async function queryOnLeave(
  from: string,
  to: string
): Promise<RowDataPacket[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT r.request_id, e.full_name, e.email, d.department_name, t.type_name,
            r.start_date, r.end_date, r.number_of_days, r.reason
     FROM leave_requests r
     JOIN employees e ON e.employee_id = r.employee_id
     JOIN departments d ON d.department_id = e.department_id
     JOIN leave_types t ON t.leave_type_id = r.leave_type_id
     WHERE r.status = 'Approved' AND r.start_date <= ? AND r.end_date >= ?
     ORDER BY r.start_date, e.full_name`,
    [to, from]
  );

  return rows;
}

function parseRequestFilters(
  q: Request["query"]
): {
  error?: string;
  where: string;
  params: (string | number)[];
} {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  const bad = (error: string) => ({
    error,
    where: "",
    params: [] as (string | number)[],
  });

  const status = String(q.status ?? "");

  if (status) {
    if (!STATUSES.includes(status)) return bad("Invalid status.");

    conditions.push("r.status = ?");
    params.push(status);
  }

  const from = String(q.from ?? "");

  if (from) {
    if (!isValidDate(from)) return bad("Invalid from date.");

    conditions.push("r.end_date >= ?");
    params.push(from);
  }

  const to = String(q.to ?? "");

  if (to) {
    if (!isValidDate(to)) return bad("Invalid to date.");

    conditions.push("r.start_date <= ?");
    params.push(to);
  }

  if (q.departmentId) {
    const id = Number(q.departmentId);

    if (!Number.isInteger(id)) return bad("Invalid department.");

    conditions.push("e.department_id = ?");
    params.push(id);
  }

  if (q.leaveTypeId) {
    const id = Number(q.leaveTypeId);

    if (!Number.isInteger(id)) return bad("Invalid leave type.");

    conditions.push("r.leave_type_id = ?");
    params.push(id);
  }

  return {
    where: conditions.length ? "WHERE " + conditions.join(" AND ") : "",
    params,
  };
}

async function queryRequests(
  where: string,
  params: (string | number)[]
): Promise<RowDataPacket[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT r.request_id, e.full_name, e.email, d.department_name, t.type_name,
            r.start_date, r.end_date, r.number_of_days, r.reason, r.status,
            r.request_date, r.decision_date, r.decision_comment,
            a.full_name AS decided_by,
            (r.document_path IS NOT NULL) AS has_document,
            COALESCE(
              (SELECT adj.old_days FROM leave_request_adjustments adj
               WHERE adj.request_id = r.request_id ORDER BY adj.adjustment_id LIMIT 1),
              r.number_of_days) AS requested_days
     FROM leave_requests r
     JOIN employees e ON e.employee_id = r.employee_id
     JOIN departments d ON d.department_id = e.department_id
     JOIN leave_types t ON t.leave_type_id = r.leave_type_id
     LEFT JOIN employees a ON a.employee_id = r.approved_by
     ${where}
     ORDER BY r.request_date DESC
     LIMIT 1000`,
    params
  );

  return rows;
}

export const getSummary = safe(async (_req, res) => {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT
       (SELECT COUNT(*) FROM leave_requests WHERE status = 'Pending') AS pending,
       (SELECT COUNT(DISTINCT employee_id) FROM leave_requests
          WHERE status = 'Approved' AND CURDATE() BETWEEN start_date AND end_date) AS on_leave_today,
       (SELECT COUNT(DISTINCT employee_id) FROM leave_requests
          WHERE status = 'Approved' AND start_date > CURDATE()
            AND start_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)) AS starting_next_30_days,
       (SELECT COUNT(*) FROM employees WHERE status = 'Active') AS active_employees,
       (SELECT COALESCE(SUM(number_of_days), 0) FROM leave_requests
          WHERE status = 'Approved' AND YEAR(start_date) = YEAR(CURDATE())) AS approved_days_this_year,
       (SELECT COUNT(*) FROM employees e WHERE e.status = 'Active'
          AND NOT EXISTS (SELECT 1 FROM leave_balances b
            WHERE b.employee_id = e.employee_id AND b.year = YEAR(CURDATE()))) AS without_balances`
  );

  const r = rows[0];

  res.json({
    pending: Number(r.pending),
    on_leave_today: Number(r.on_leave_today),
    starting_next_30_days: Number(r.starting_next_30_days),
    active_employees: Number(r.active_employees),
    approved_days_this_year: Number(r.approved_days_this_year),
    without_balances: Number(r.without_balances),
  });
});

export const getOnLeave = safe(async (req, res) => {
  const range = parseRange(req.query);

  if (range.error) {
    res.status(400).json({ message: range.error });
    return;
  }

  res.json(await queryOnLeave(range.from, range.to));
});

export const exportOnLeave = safe(async (req, res) => {
  const range = parseRange(req.query);

  if (range.error) {
    res.status(400).json({ message: range.error });
    return;
  }

  const rows = await queryOnLeave(range.from, range.to);

  const csv = toCsv(
    [
      "Full name",
      "Email",
      "Department",
      "Leave type",
      "Start date",
      "End date",
      "Working days",
      "Reason",
    ],
    rows.map((r) => [
      r.full_name,
      r.email,
      r.department_name,
      r.type_name,
      r.start_date,
      r.end_date,
      r.number_of_days,
      r.reason,
    ])
  );

  sendCsv(
    res,
    `employees-on-leave-${range.from}-to-${range.to}.csv`,
    csv
  );
});

export const getRequests = safe(async (req, res) => {
  const f = parseRequestFilters(req.query);

  if (f.error) {
    res.status(400).json({ message: f.error });
    return;
  }

  res.json(await queryRequests(f.where, f.params));
});

export const exportRequests = safe(async (req, res) => {
  const f = parseRequestFilters(req.query);

  if (f.error) {
    res.status(400).json({ message: f.error });
    return;
  }

  const rows = await queryRequests(f.where, f.params);

  const csv = toCsv(
    [
      "Request id",
      "Full name",
      "Email",
      "Department",
      "Leave type",
      "Start date",
      "End date",
      "Working days",
      "Reason",
      "Status",
      "Requested on",
      "Decided on",
      "Decided by",
      "Decision comment",
    ],
    rows.map((r) => [
      r.request_id,
      r.full_name,
      r.email,
      r.department_name,
      r.type_name,
      r.start_date,
      r.end_date,
      r.number_of_days,
      r.reason,
      r.status,
      r.request_date,
      r.decision_date,
      r.decided_by,
      r.decision_comment,
    ])
  );

  sendCsv(res, `leave-requests-${todayString()}.csv`, csv);
});

export const getAnalytics = safe(async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();

  const [byType] = await pool.query<RowDataPacket[]>(
    `SELECT t.type_name,
            COALESCE(SUM(r.number_of_days), 0) AS days,
            COUNT(r.request_id) AS requests
     FROM leave_types t
     LEFT JOIN leave_requests r ON r.leave_type_id = t.leave_type_id
       AND r.status = 'Approved' AND YEAR(r.start_date) = ?
     GROUP BY t.leave_type_id, t.type_name
     ORDER BY t.leave_type_id`,
    [year]
  );

  const [byDepartment] = await pool.query<RowDataPacket[]>(
    `SELECT d.department_name,
            COUNT(DISTINCT e.employee_id) AS employees,
            COALESCE(SUM(r.number_of_days), 0) AS days
     FROM departments d
     LEFT JOIN employees e ON e.department_id = d.department_id
     LEFT JOIN leave_requests r ON r.employee_id = e.employee_id
       AND r.status = 'Approved' AND YEAR(r.start_date) = ?
     GROUP BY d.department_id, d.department_name
     ORDER BY d.department_name`,
    [year]
  );

  const [monthRows] = await pool.query<RowDataPacket[]>(
    `SELECT MONTH(start_date) AS month,
            SUM(number_of_days) AS days
     FROM leave_requests
     WHERE status = 'Approved' AND YEAR(start_date) = ?
     GROUP BY MONTH(start_date)`,
    [year]
  );

  const byMonth = Array.from({ length: 12 }, (_, i) => {
    const found = monthRows.find(
      (m) => Number(m.month) === i + 1
    );

    return {
      month: i + 1,
      days: found ? Number(found.days) : 0,
    };
  });

  const [byStatus] = await pool.query<RowDataPacket[]>(
    `SELECT status, COUNT(*) AS total
     FROM leave_requests
     WHERE YEAR(start_date) = ?
     GROUP BY status`,
    [year]
  );

  res.json({
    year,
    byType: byType.map((r) => ({
      type_name: r.type_name,
      days: Number(r.days),
      requests: Number(r.requests),
    })),
    byDepartment: byDepartment.map((r) => ({
      department_name: r.department_name,
      employees: Number(r.employees),
      days: Number(r.days),
    })),
    byMonth,
    byStatus: byStatus.map((r) => ({
      status: r.status,
      total: Number(r.total),
    })),
  });
});

export const getEmployees = safe(async (_req, res) => {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT e.employee_id,
            e.full_name,
            e.email,
            d.department_name,
            e.status,
            u.role,
            (SELECT b.days_allocated - b.days_used
               FROM leave_balances b
               JOIN leave_types t ON t.leave_type_id = b.leave_type_id
               WHERE b.employee_id = e.employee_id
                 AND t.type_name = 'Annual'
                 AND b.year = YEAR(CURDATE())
               LIMIT 1) AS annual_remaining,
            EXISTS(
              SELECT 1
              FROM leave_requests r
              WHERE r.employee_id = e.employee_id
                AND r.status = 'Approved'
                AND CURDATE() BETWEEN r.start_date AND r.end_date
            ) AS on_leave_today
     FROM employees e
     JOIN departments d ON d.department_id = e.department_id
     LEFT JOIN users u ON u.employee_id = e.employee_id
     ORDER BY e.full_name`
  );

  res.json(
    rows.map((r) => ({
      employee_id: r.employee_id,
      full_name: r.full_name,
      email: r.email,
      department_name: r.department_name,
      status: r.status,
      role: r.role,
      annual_remaining:
        r.annual_remaining === null
          ? null
          : Number(r.annual_remaining),
      on_leave_today: Number(r.on_leave_today) === 1,
    }))
  );
});

export const generateBalances = safe(async (req, res) => {
  const year = Number(req.body.year);
  const carry = Number(req.body.carryOverMax ?? 0);

  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    res.status(400).json({ message: "Enter a valid year." });
    return;
  }

  if (!Number.isInteger(carry) || carry < 0 || carry > 365) {
    res.status(400).json({
      message: "Carry over must be a whole number from 0 to 365.",
    });
    return;
  }

  // Carry over applies to the leave type named Annual only.
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT IGNORE INTO leave_balances
      (employee_id, leave_type_id, year, days_allocated, days_used)
     SELECT e.employee_id,
            t.leave_type_id,
            ?,
            t.days_allowed_per_year +
            CASE
              WHEN t.type_name = 'Annual' THEN
                LEAST(
                  ?,
                  COALESCE(
                    (
                      SELECT GREATEST(
                        p.days_allocated - p.days_used,
                        0
                      )
                      FROM leave_balances p
                      WHERE p.employee_id = e.employee_id
                        AND p.leave_type_id = t.leave_type_id
                        AND p.year = ? - 1
                    ),
                    0
                  )
                )
              ELSE 0
            END,
            0
     FROM employees e
     CROSS JOIN leave_types t
     WHERE e.status = 'Active'`,
    [year, carry, year]
  );

  res.json({
    message: `Created ${result.affectedRows} balances for ${year}. Existing balances were left unchanged.`,
  });
});