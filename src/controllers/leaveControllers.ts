import type { Request, Response } from "express";
import type { RowDataPacket, ResultSetHeader } from "mysql2";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { pool } from "../db";
import type { AuthedRequest } from "../middleware/auth";

// Documents are stored on disk, outside any public folder
const UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Which requester roles each approver role is allowed to decide (and see documents of)
const DECIDES: Record<string, string[]> = {
  Manager: ["Employee"],
  HR: ["Employee", "Manager"],
  Chief: ["HR", "Chief"],
};

function currentUser(req: Request) {
  return (req as AuthedRequest).user!;
}

async function getEmployeeId(userId: number): Promise<number | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT employee_id FROM users WHERE user_id = ?",
    [userId]
  );
  return rows[0] ? rows[0].employee_id : null;
}

function isValidDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(new Date(value + "T00:00:00").getTime())
  );
}

function formatDate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function todayString(): string {
  return formatDate(new Date());
}

function shiftDate(date: string, days: number): string {
  const d = new Date(date + "T00:00:00");
  d.setDate(d.getDate() + days);
  return formatDate(d);
}

// Counts Monday to Friday only. Public holidays are not excluded yet.
function countWorkingDays(start: string, end: string): number {
  const last = new Date(end + "T00:00:00");
  let count = 0;
  for (let d = new Date(start + "T00:00:00"); d <= last; d.setDate(d.getDate() + 1)) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

// Checks the real file content, not the name or the type the browser claims
function detectFileType(buf: Buffer): { ext: string; mime: string } | null {
  if (buf.length >= 4 && buf.subarray(0, 4).toString("latin1") === "%PDF") {
    return { ext: "pdf", mime: "application/pdf" };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: "jpg", mime: "image/jpeg" };
  }
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length >= 8 && buf.subarray(0, 8).equals(png)) {
    return { ext: "png", mime: "image/png" };
  }
  return null;
}

function cleanFileName(name: string): string {
  return name.replace(/[^\w.\- ]/g, "_").slice(0, 100);
}

export async function getLeaveTypes(_req: Request, res: Response): Promise<void> {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT leave_type_id, type_name, requires_document, auto_approve, max_backdate_days
       FROM leave_types ORDER BY leave_type_id`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function getMyBalances(req: Request, res: Response): Promise<void> {
  try {
    const employeeId = await getEmployeeId(currentUser(req).userId);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT t.leave_type_id, t.type_name, b.days_allocated, b.days_used,
              (b.days_allocated - b.days_used) AS days_remaining
       FROM leave_balances b
       JOIN leave_types t ON t.leave_type_id = b.leave_type_id
       WHERE b.employee_id = ? AND b.year = YEAR(CURDATE())
       ORDER BY t.leave_type_id`,
      [employeeId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function getMyRequests(req: Request, res: Response): Promise<void> {
  try {
    const employeeId = await getEmployeeId(currentUser(req).userId);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT r.request_id, t.type_name, r.start_date, r.end_date, r.number_of_days,
              r.reason, r.status, r.decision_comment,
              (r.document_path IS NOT NULL) AS has_document
       FROM leave_requests r
       JOIN leave_types t ON t.leave_type_id = r.leave_type_id
       WHERE r.employee_id = ?
       ORDER BY r.request_date DESC`,
      [employeeId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function createRequest(req: Request, res: Response): Promise<void> {
  const { leaveTypeId, startDate, endDate, reason } = req.body;
  const file = (req as Request & { file?: Express.Multer.File }).file;

  if (!leaveTypeId || !isValidDate(startDate) || !isValidDate(endDate)) {
    res.status(400).json({ message: "Choose a leave type, a start date and an end date." });
    return;
  }
  if (endDate < startDate) {
    res.status(400).json({ message: "The end date cannot be before the start date." });
    return;
  }
  if (startDate.slice(0, 4) !== endDate.slice(0, 4)) {
    res.status(400).json({ message: "Please submit separate requests for each year." });
    return;
  }
  const days = countWorkingDays(startDate, endDate);
  if (days < 1) {
    res.status(400).json({ message: "Those dates contain no working days." });
    return;
  }

  const conn = await pool.getConnection();
  let savedName: string | null = null;
  try {
    const [typeRows] = await conn.query<RowDataPacket[]>(
      `SELECT leave_type_id, type_name, requires_document, auto_approve, max_backdate_days
       FROM leave_types WHERE leave_type_id = ?`,
      [leaveTypeId]
    );
    const type = typeRows[0];
    if (!type) {
      res.status(400).json({ message: "Unknown leave type." });
      return;
    }

    const maxBack = Number(type.max_backdate_days);
    if (startDate < shiftDate(todayString(), -maxBack)) {
      res.status(400).json({
        message:
          maxBack === 0
            ? "The start date cannot be in the past."
            : `For ${type.type_name} leave the start date can be at most ${maxBack} days in the past.`,
      });
      return;
    }

    if (Number(type.requires_document) === 1 && !file) {
      res.status(400).json({
        message: `${type.type_name} leave needs a supporting document, for example the hospital certificate.`,
      });
      return;
    }

    let detected: { ext: string; mime: string } | null = null;
    if (file) {
      detected = detectFileType(file.buffer);
      if (!detected) {
        res.status(400).json({ message: "Only PDF, JPG or PNG files are accepted." });
        return;
      }
    }

    const employeeId = await getEmployeeId(currentUser(req).userId);
    const year = Number(startDate.slice(0, 4));

    await conn.beginTransaction();

    const [bal] = await conn.query<RowDataPacket[]>(
      `SELECT (days_allocated - days_used) AS remaining
       FROM leave_balances
       WHERE employee_id = ? AND leave_type_id = ? AND year = ? FOR UPDATE`,
      [employeeId, leaveTypeId, year]
    );
    if (!bal[0]) {
      await conn.rollback();
      res.status(400).json({ message: "No leave balance exists for that type and year." });
      return;
    }

    const [pend] = await conn.query<RowDataPacket[]>(
      `SELECT COALESCE(SUM(number_of_days), 0) AS pending_days
       FROM leave_requests
       WHERE employee_id = ? AND leave_type_id = ? AND status = 'Pending'
         AND YEAR(start_date) = ?`,
      [employeeId, leaveTypeId, year]
    );
    const available = Number(bal[0].remaining) - Number(pend[0].pending_days);
    if (days > available) {
      await conn.rollback();
      res.status(400).json({
        message: `You asked for ${days} working days but only ${available} are available (pending requests included).`,
      });
      return;
    }

    const [overlap] = await conn.query<RowDataPacket[]>(
      `SELECT request_id FROM leave_requests
       WHERE employee_id = ? AND status IN ('Pending','Approved')
         AND start_date <= ? AND end_date >= ? LIMIT 1`,
      [employeeId, endDate, startDate]
    );
    if (overlap[0]) {
      await conn.rollback();
      res.status(409).json({ message: "You already have a request that overlaps those dates." });
      return;
    }

    if (file && detected) {
      savedName = `${crypto.randomUUID()}.${detected.ext}`;
      await fs.promises.writeFile(path.join(UPLOAD_DIR, savedName), file.buffer);
    }

    const autoApprove = Number(type.auto_approve) === 1;
    const autoComment = autoApprove
      ? "Approved automatically" + (savedName ? " with supporting document" : "")
      : null;

    await conn.query(
      `INSERT INTO leave_requests
         (employee_id, leave_type_id, start_date, end_date, number_of_days, reason,
          status, decision_date, decision_comment, seen_by_employee,
          document_path, document_name, document_mime)
       VALUES (?, ?, ?, ?, ?, ?, ?, IF(? = 1, NOW(), NULL), ?, 1, ?, ?, ?)`,
      [
        employeeId,
        leaveTypeId,
        startDate,
        endDate,
        days,
        reason ? String(reason).slice(0, 255) : null,
        autoApprove ? "Approved" : "Pending",
        autoApprove ? 1 : 0,
        autoComment,
        savedName,
        file ? cleanFileName(file.originalname) : null,
        detected ? detected.mime : null,
      ]
    );

    if (autoApprove) {
      await conn.query(
        `UPDATE leave_balances SET days_used = days_used + ?
         WHERE employee_id = ? AND leave_type_id = ? AND year = ?`,
        [days, employeeId, leaveTypeId, year]
      );
    }

    await conn.commit();
    res.status(201).json({
      message: autoApprove
        ? `${type.type_name} leave approved automatically for ${days} working days. Your document was saved for review.`
        : `Request submitted for ${days} working days.`,
    });
  } catch (err) {
    await conn.rollback();
    if (savedName) {
      fs.promises.unlink(path.join(UPLOAD_DIR, savedName)).catch(() => undefined);
    }
    console.error(err);
    res.status(500).json({ message: "Database error" });
  } finally {
    conn.release();
  }
}

export async function cancelRequest(req: Request, res: Response): Promise<void> {
  try {
    const employeeId = await getEmployeeId(currentUser(req).userId);
    const [result] = await pool.query<ResultSetHeader>(
      `UPDATE leave_requests SET status = 'Cancelled'
       WHERE request_id = ? AND employee_id = ? AND status = 'Pending'`,
      [req.params.id, employeeId]
    );
    if (!result.affectedRows) {
      res.status(404).json({ message: "No pending request found to cancel." });
      return;
    }
    res.json({ message: "Request cancelled." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function getDocument(req: Request, res: Response): Promise<void> {
  try {
    const user = currentUser(req);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT r.employee_id, r.document_path, r.document_mime, u.role AS requester_role
       FROM leave_requests r
       JOIN users u ON u.employee_id = r.employee_id
       WHERE r.request_id = ?`,
      [req.params.id]
    );
    const row = rows[0];
    if (!row || !row.document_path) {
      res.status(404).json({ message: "No document found for this request." });
      return;
    }

    const myEmployeeId = await getEmployeeId(user.userId);
    const isOwner = row.employee_id === myEmployeeId;
    const isApprover = (DECIDES[user.role] || []).includes(row.requester_role);
    if (!isOwner && !isApprover) {
      res.status(403).json({ message: "You do not have permission to view this document." });
      return;
    }

    const fullPath = path.join(UPLOAD_DIR, path.basename(row.document_path));
    if (!fs.existsSync(fullPath)) {
      res.status(404).json({ message: "The document file is missing from the server." });
      return;
    }

    res.setHeader("Content-Type", row.document_mime || "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.sendFile(fullPath);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function getPending(req: Request, res: Response): Promise<void> {
  try {
    const allowedRoles = DECIDES[currentUser(req).role] || [];
    if (allowedRoles.length === 0) {
      res.json([]);
      return;
    }
    const employeeId = await getEmployeeId(currentUser(req).userId);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT r.request_id, e.full_name, e.email, d.department_name, t.type_name,
              r.start_date, r.end_date, r.number_of_days, r.reason,
              (r.document_path IS NOT NULL) AS has_document
       FROM leave_requests r
       JOIN employees e ON e.employee_id = r.employee_id
       JOIN users ru ON ru.employee_id = r.employee_id
       JOIN departments d ON d.department_id = e.department_id
       JOIN leave_types t ON t.leave_type_id = r.leave_type_id
       WHERE r.status = 'Pending' AND r.employee_id <> ? AND ru.role IN (?)
       ORDER BY r.request_date`,
      [employeeId, allowedRoles]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function decideRequest(req: Request, res: Response): Promise<void> {
  const { decision, comment } = req.body;
  if (decision !== "Approved" && decision !== "Rejected") {
    res.status(400).json({ message: "Decision must be Approved or Rejected." });
    return;
  }

  const cleanComment = comment ? String(comment).trim().slice(0, 255) : "";
  if (decision === "Rejected" && cleanComment.length < 3) {
    res.status(400).json({ message: "Please give a reason for rejecting (at least 3 characters)." });
    return;
  }

  const conn = await pool.getConnection();
  try {
    const deciderId = await getEmployeeId(currentUser(req).userId);
    await conn.beginTransaction();

    const [rows] = await conn.query<RowDataPacket[]>(
      "SELECT * FROM leave_requests WHERE request_id = ? FOR UPDATE",
      [req.params.id]
    );
    const request = rows[0];
    if (!request) {
      await conn.rollback();
      res.status(404).json({ message: "Request not found." });
      return;
    }
    if (request.status !== "Pending") {
      await conn.rollback();
      res.status(409).json({ message: "This request has already been decided." });
      return;
    }
    if (request.employee_id === deciderId) {
      await conn.rollback();
      res.status(403).json({ message: "You cannot decide your own request." });
      return;
    }

    // The approver's role must be allowed to decide the requester's role
    const [roleRows] = await conn.query<RowDataPacket[]>(
      "SELECT role FROM users WHERE employee_id = ?",
      [request.employee_id]
    );
    const requesterRole: string = roleRows[0] ? roleRows[0].role : "Employee";
    const allowedRoles = DECIDES[currentUser(req).role] || [];
    if (!allowedRoles.includes(requesterRole)) {
      await conn.rollback();
      res.status(403).json({ message: "You are not allowed to decide this request." });
      return;
    }

    if (decision === "Approved") {
      const year = Number(String(request.start_date).slice(0, 4));
      const [upd] = await conn.query<ResultSetHeader>(
        `UPDATE leave_balances SET days_used = days_used + ?
         WHERE employee_id = ? AND leave_type_id = ? AND year = ?
           AND (days_allocated - days_used) >= ?`,
        [request.number_of_days, request.employee_id, request.leave_type_id, year, request.number_of_days]
      );
      if (!upd.affectedRows) {
        await conn.rollback();
        res.status(400).json({ message: "The employee does not have enough days left." });
        return;
      }
    }

    await conn.query(
      `UPDATE leave_requests
       SET status = ?, approved_by = ?, decision_date = NOW(),
           decision_comment = ?, seen_by_employee = 0
       WHERE request_id = ?`,
      [decision, deciderId, cleanComment || null, req.params.id]
    );

    await conn.commit();
    res.json({ message: `Request ${decision.toLowerCase()}.` });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: "Database error" });
  } finally {
    conn.release();
  }
}

export async function getNotifications(req: Request, res: Response): Promise<void> {
  try {
    const employeeId = await getEmployeeId(currentUser(req).userId);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT r.request_id, t.type_name, r.start_date, r.end_date, r.number_of_days,
              r.status, r.decision_comment, r.decision_date, a.full_name AS decided_by
       FROM leave_requests r
       JOIN leave_types t ON t.leave_type_id = r.leave_type_id
       LEFT JOIN employees a ON a.employee_id = r.approved_by
       WHERE r.employee_id = ? AND r.seen_by_employee = 0
         AND r.status IN ('Approved', 'Rejected')
       ORDER BY r.decision_date DESC`,
      [employeeId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function markNotificationsRead(req: Request, res: Response): Promise<void> {
  const ids: unknown = req.body.ids;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((n) => Number.isInteger(n))) {
    res.status(400).json({ message: "Nothing to mark." });
    return;
  }
  try {
    const employeeId = await getEmployeeId(currentUser(req).userId);
    await pool.query(
      "UPDATE leave_requests SET seen_by_employee = 1 WHERE employee_id = ? AND request_id IN (?)",
      [employeeId, ids]
    );
    res.json({ message: "Marked as read." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

// Requests the logged in approver has approved or rejected
export async function getMyDecisions(req: Request, res: Response): Promise<void> {
  try {
    const employeeId = await getEmployeeId(currentUser(req).userId);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT r.request_id, e.full_name, e.email, d.department_name, t.type_name,
              r.start_date, r.end_date, r.number_of_days, r.status,
              r.decision_date, r.decision_comment
       FROM leave_requests r
       JOIN employees e ON e.employee_id = r.employee_id
       JOIN departments d ON d.department_id = e.department_id
       JOIN leave_types t ON t.leave_type_id = r.leave_type_id
       WHERE r.approved_by = ? AND r.status IN ('Approved', 'Rejected')
       ORDER BY r.decision_date DESC
       LIMIT 500`,
      [employeeId]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

// Chief only: HR staff on approved leave in a date range (reasons are not shown)
export async function getHrOnLeave(req: Request, res: Response): Promise<void> {
  const from = req.query.from ? String(req.query.from) : todayString();
  const to = req.query.to ? String(req.query.to) : from;
  if (!isValidDate(from) || !isValidDate(to)) {
    res.status(400).json({ message: "Invalid date." });
    return;
  }
  if (to < from) {
    res.status(400).json({ message: "The end date cannot be before the start date." });
    return;
  }
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT e.full_name, e.email, d.department_name, t.type_name,
              r.start_date, r.end_date, r.number_of_days
       FROM leave_requests r
       JOIN employees e ON e.employee_id = r.employee_id
       JOIN users u ON u.employee_id = r.employee_id
       JOIN departments d ON d.department_id = e.department_id
       JOIN leave_types t ON t.leave_type_id = r.leave_type_id
       WHERE r.status = 'Approved' AND u.role = 'HR'
         AND r.start_date <= ? AND r.end_date >= ?
       ORDER BY r.start_date, e.full_name`,
      [to, from]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}