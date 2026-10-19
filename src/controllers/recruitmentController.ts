import type { Response } from "express";
import type { RowDataPacket, ResultSetHeader } from "mysql2";
import { pool } from "../db";
import PDFDocument from "pdfkit";
import type { AuthedRequest } from "../middleware/auth";
import bcrypt from "bcryptjs";

const VACANCY_STATUSES = ["Open", "Closed", "Filled"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function todayString(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function isValidDate(value: string): boolean {
  return DATE_RE.test(value) && !Number.isNaN(new Date(value + "T00:00:00").getTime());
}

/* ---------- list ---------- */

export async function listVacancies(req: AuthedRequest, res: Response): Promise<void> {
  const page = Math.max(parseInt(asText(req.query.page), 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(asText(req.query.limit), 10) || 10, 1), 100);
  const search = asText(req.query.search);
  const status = asText(req.query.status);
  const departmentId = parseInt(asText(req.query.department_id), 10) || null;

  try {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (search) {
      where.push("v.title LIKE ?");
      params.push(`%${search}%`);
    }
    if (departmentId) {
      where.push("v.department_id = ?");
      params.push(departmentId);
    }
    if (VACANCY_STATUSES.includes(status)) {
      where.push("v.status = ?");
      params.push(status);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT v.vacancy_id, v.title, v.department_id, d.department_name,
              v.openings, v.closing_date, v.status, v.created_at,
              (SELECT COUNT(*) FROM applications a WHERE a.vacancy_id = v.vacancy_id) AS applications,
              (SELECT COUNT(*) FROM applications a
                 WHERE a.vacancy_id = v.vacancy_id AND a.status = 'Hired') AS hired
       FROM vacancies v
       JOIN departments d ON d.department_id = v.department_id
       ${whereSql}
       ORDER BY FIELD(v.status, 'Open', 'Closed', 'Filled'), v.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );

    const [count] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM vacancies v ${whereSql}`,
      params
    );
    const total = Number(count[0].total);

    res.json({
      data: rows.map((r) => ({
        ...r,
        applications: Number(r.applications),
        hired: Number(r.hired),
      })),
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

/* ---------- view one ---------- */

export async function getVacancy(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  if (!id) {
    res.status(400).json({ message: "Invalid vacancy id." });
    return;
  }

  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT v.vacancy_id, v.title, v.department_id, d.department_name,
              v.description, v.requirements, v.openings, v.closing_date, v.status,
              v.created_at, v.updated_at, u.full_name AS created_by_name,
              (SELECT COUNT(*) FROM applications a WHERE a.vacancy_id = v.vacancy_id) AS applications,
              (SELECT COUNT(*) FROM applications a
                 WHERE a.vacancy_id = v.vacancy_id AND a.status = 'Hired') AS hired
       FROM vacancies v
       JOIN departments d ON d.department_id = v.department_id
       LEFT JOIN users u ON u.user_id = v.created_by
       WHERE v.vacancy_id = ?`,
      [id]
    );
    const v = rows[0];
    if (!v) {
      res.status(404).json({ message: "Vacancy not found." });
      return;
    }
    res.json({ data: { ...v, applications: Number(v.applications), hired: Number(v.hired) } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

/* ---------- create (HR) ---------- */

export async function createVacancy(req: AuthedRequest, res: Response): Promise<void> {
  const b = req.body ?? {};
  const title = asText(b.title);
  const departmentId = parseInt(asText(String(b.departmentId ?? "")), 10);
  const openings = b.openings === undefined || b.openings === "" ? 1 : Number(b.openings);
  const closingDate = asText(b.closingDate);
  const description = asText(b.description);
  const requirements = asText(b.requirements);

  const errors: string[] = [];
  if (!title) errors.push("Job title is required.");
  if (title.length > 150) errors.push("Job title must be 150 characters or fewer.");
  if (!departmentId) errors.push("Department is required.");
  if (!Number.isInteger(openings) || openings < 1 || openings > 100) {
    errors.push("Openings must be a whole number from 1 to 100.");
  }
  if (closingDate) {
    if (!isValidDate(closingDate)) errors.push("Closing date must be YYYY-MM-DD.");
    else if (closingDate < todayString()) errors.push("The closing date cannot be in the past.");
  }
  if (errors.length) {
    res.status(400).json({ message: errors[0], errors });
    return;
  }

  try {
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO vacancies
         (title, department_id, description, requirements, openings, closing_date, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [title, departmentId, description || null, requirements || null,
       openings, closingDate || null, req.user?.userId ?? null]
    );
    res.status(201).json({ message: "Vacancy created", vacancy_id: result.insertId });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "ER_NO_REFERENCED_ROW_2") {
      res.status(400).json({ message: "Invalid department." });
    } else {
      console.error(err);
      res.status(500).json({ message: "Database error" });
    }
  }
}

/* ---------- edit (HR) ---------- */

export async function updateVacancy(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  if (!id) {
    res.status(400).json({ message: "Invalid vacancy id." });
    return;
  }

  const b = req.body ?? {};
  const updates: Record<string, string | number | null> = {};
  const errors: string[] = [];

  if (b.title !== undefined) {
    const title = asText(b.title);
    if (!title) errors.push("Job title cannot be empty.");
    else if (title.length > 150) errors.push("Job title must be 150 characters or fewer.");
    else updates.title = title;
  }
  if (b.departmentId !== undefined) {
    const n = parseInt(asText(String(b.departmentId)), 10);
    if (!n) errors.push("Department must be a valid id.");
    else updates.department_id = n;
  }
  if (b.openings !== undefined) {
    const n = Number(b.openings);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      errors.push("Openings must be a whole number from 1 to 100.");
    } else updates.openings = n;
  }
  if (b.closingDate !== undefined) {
    const d = asText(b.closingDate);
    if (d && !isValidDate(d)) errors.push("Closing date must be YYYY-MM-DD.");
    else updates.closing_date = d || null;
  }
  if (b.description !== undefined) updates.description = asText(b.description) || null;
  if (b.requirements !== undefined) updates.requirements = asText(b.requirements) || null;

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
      `SELECT v.vacancy_id,
              (SELECT COUNT(*) FROM applications a
                 WHERE a.vacancy_id = v.vacancy_id AND a.status = 'Hired') AS hired
       FROM vacancies v WHERE v.vacancy_id = ?`,
      [id]
    );
    if (!found[0]) {
      res.status(404).json({ message: "Vacancy not found." });
      return;
    }
    if (typeof updates.openings === "number" && updates.openings < Number(found[0].hired)) {
      res.status(400).json({
        message: `Openings cannot be fewer than the ${found[0].hired} people already hired.`,
      });
      return;
    }

    const cols = Object.keys(updates);
    await pool.query(
      `UPDATE vacancies SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE vacancy_id = ?`,
      [...cols.map((c) => updates[c]), id]
    );
    res.json({ message: "Vacancy updated", changed: cols });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "ER_NO_REFERENCED_ROW_2") {
      res.status(400).json({ message: "Invalid department." });
    } else {
      console.error(err);
      res.status(500).json({ message: "Database error" });
    }
  }
}

/* ---------- close / reopen / mark filled (HR) ---------- */

export async function changeVacancyStatus(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  const status = asText(req.body?.status);

  if (!id) {
    res.status(400).json({ message: "Invalid vacancy id." });
    return;
  }
  if (!VACANCY_STATUSES.includes(status)) {
    res.status(400).json({ message: "Status must be Open, Closed or Filled." });
    return;
  }

  try {
    const [found] = await pool.query<RowDataPacket[]>(
      `SELECT v.status, v.openings,
              (SELECT COUNT(*) FROM applications a
                 WHERE a.vacancy_id = v.vacancy_id AND a.status = 'Hired') AS hired
       FROM vacancies v WHERE v.vacancy_id = ?`,
      [id]
    );
    const v = found[0];
    if (!v) {
      res.status(404).json({ message: "Vacancy not found." });
      return;
    }
    if (v.status === status) {
      res.json({ message: "No changes", status });
      return;
    }
    if (status === "Open" && Number(v.hired) >= Number(v.openings)) {
      res.status(400).json({
        message: "All openings are already filled. Increase the number of openings first.",
      });
      return;
    }

    await pool.query("UPDATE vacancies SET status = ? WHERE vacancy_id = ?", [status, id]);
    res.json({ message: `Vacancy is now ${status}`, status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}
/* ---------- applications ---------- */

const APPLICATION_STATUSES = [
  "Applied", "Shortlisted", "Interview", "Selected", "Rejected", "Hired", "Withdrawn",
];

// Stage moves HR may make. "Hired" is set only when the person is converted to an employee.
const NEXT_STATUSES: Record<string, string[]> = {
  Applied: ["Shortlisted", "Rejected", "Withdrawn"],
  Shortlisted: ["Interview", "Rejected", "Withdrawn"],
  Interview: ["Selected", "Rejected", "Withdrawn"],
  Selected: ["Rejected", "Withdrawn"],
  Rejected: [],
  Withdrawn: [],
  Hired: [],
};

export async function listApplications(req: AuthedRequest, res: Response): Promise<void> {
  const vacancyId = parseInt(String(req.params.id), 10);
  const status = asText(req.query.status);

  if (!vacancyId) {
    res.status(400).json({ message: "Invalid vacancy id." });
    return;
  }

  try {
    const where = ["a.vacancy_id = ?"];
    const params: (string | number)[] = [vacancyId];
    if (APPLICATION_STATUSES.includes(status)) {
      where.push("a.status = ?");
      params.push(status);
    }

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT a.application_id, a.status, a.applied_date, a.notes, a.employee_id,
              p.applicant_id, p.full_name, p.email, p.phone,
              (SELECT COUNT(*) FROM interviews i WHERE i.application_id = a.application_id) AS interviews
       FROM applications a
       JOIN applicants p ON p.applicant_id = a.applicant_id
       WHERE ${where.join(" AND ")}
       ORDER BY FIELD(a.status, 'Applied','Shortlisted','Interview','Selected','Hired','Rejected','Withdrawn'),
                a.applied_date DESC, a.application_id DESC`,
      params
    );

    res.json({ data: rows.map((r) => ({ ...r, interviews: Number(r.interviews) })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function getApplication(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  if (!id) {
    res.status(400).json({ message: "Invalid application id." });
    return;
  }

  try {
    const [rows] = await pool.query<RowDataPacket[]>(
            `SELECT a.application_id, a.vacancy_id, v.title AS vacancy_title, v.openings,
              v.department_id AS vacancy_department_id,
              a.status, a.applied_date, a.notes, a.employee_id,
              p.applicant_id, p.full_name, p.email, p.phone, p.national_id,
              p.gender, p.date_of_birth, p.address
       FROM applications a
       JOIN applicants p ON p.applicant_id = a.applicant_id
       JOIN vacancies v ON v.vacancy_id = a.vacancy_id
       WHERE a.application_id = ?`,
      [id]
    );
    const app = rows[0];
    if (!app) {
      res.status(404).json({ message: "Application not found." });
      return;
    }

    const [history] = await pool.query<RowDataPacket[]>(
      `SELECT h.id, h.from_status, h.to_status, h.comment, h.changed_at,
              u.full_name AS changed_by
       FROM application_history h
       LEFT JOIN users u ON u.user_id = h.changed_by
       WHERE h.application_id = ?
       ORDER BY h.changed_at DESC, h.id DESC`,
      [id]
    );

    res.json({
      data: { ...app, next_statuses: NEXT_STATUSES[app.status as string] ?? [], history },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function createApplication(req: AuthedRequest, res: Response): Promise<void> {
  const vacancyId = parseInt(String(req.params.id), 10);
  const b = req.body ?? {};
  const fullName = asText(b.fullName);
  const email = asText(b.email).toLowerCase();
  const phone = asText(b.phone) || null;
  const nationalId = asText(b.nationalId) || null;
  const gender = asText(b.gender) || null;
  const dateOfBirth = asText(b.dateOfBirth) || null;
  const address = asText(b.address) || null;
  const notes = asText(b.notes) || null;
  const appliedDate = asText(b.appliedDate) || todayString();

  const errors: string[] = [];
  if (!vacancyId) errors.push("Invalid vacancy id.");
  if (!fullName) errors.push("Full name is required.");
  if (!/^\S+@\S+\.\S+$/.test(email)) errors.push("A valid email is required.");
  if (phone && !/^[0-9+\-\s()]{7,30}$/.test(phone)) errors.push("Invalid phone number.");
  if (gender && !["Male", "Female", "Other"].includes(gender)) errors.push("Invalid gender.");
  if (dateOfBirth && !isValidDate(dateOfBirth)) errors.push("Invalid date of birth.");
  if (!isValidDate(appliedDate)) errors.push("Applied date must be YYYY-MM-DD.");
  else if (appliedDate > todayString()) errors.push("The applied date cannot be in the future.");
  if (errors.length) {
    res.status(400).json({ message: errors[0], errors });
    return;
  }

  const conn = await pool.getConnection();
  try {
        const [vac] = await conn.query<RowDataPacket[]>(
      "SELECT status, closing_date FROM vacancies WHERE vacancy_id = ?",
      [vacancyId]
    );
    if (!vac[0]) {
      res.status(404).json({ message: "Vacancy not found." });
      return;
    }
    if (vac[0].status !== "Open") {
      res.status(400).json({ message: "This vacancy is not open for applications." });
      return;
    }
        if (vac[0].closing_date && String(vac[0].closing_date).slice(0, 10) < todayString()) {
      res.status(400).json({
        message: "The closing date for this vacancy has passed. Extend it by editing the vacancy.",
      });
      return;
    }

    await conn.beginTransaction();

    // One person, entered once: reuse the applicant if the email already exists
    const [existing] = await conn.query<RowDataPacket[]>(
      "SELECT applicant_id FROM applicants WHERE email = ?",
      [email]
    );
    let applicantId: number;
    let reused = false;
    if (existing[0]) {
      applicantId = existing[0].applicant_id;
      reused = true;
    } else {
      const [ins] = await conn.query<ResultSetHeader>(
        `INSERT INTO applicants (full_name, email, phone, national_id, gender, date_of_birth, address)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [fullName, email, phone, nationalId, gender, dateOfBirth, address]
      );
      applicantId = ins.insertId;
    }

    const [app] = await conn.query<ResultSetHeader>(
      `INSERT INTO applications (vacancy_id, applicant_id, status, applied_date, notes, created_by)
       VALUES (?, ?, 'Applied', ?, ?, ?)`,
      [vacancyId, applicantId, appliedDate, notes, req.user?.userId ?? null]
    );
    await conn.query(
      `INSERT INTO application_history (application_id, from_status, to_status, comment, changed_by)
       VALUES (?, NULL, 'Applied', ?, ?)`,
      [app.insertId, "Application received", req.user?.userId ?? null]
    );

    await conn.commit();
    res.status(201).json({
      message: reused
        ? "Application added. This person was already in the system, so their existing record was used."
        : "Application added",
      application_id: app.insertId,
      applicant_id: applicantId,
    });
  } catch (err) {
    await conn.rollback();
    const e = err as { code?: string; sqlMessage?: string };
    if (e.code === "ER_DUP_ENTRY") {
      if (e.sqlMessage?.includes("uq_application")) {
        res.status(409).json({ message: "This person has already applied for this vacancy." });
      } else if (e.sqlMessage?.includes("national_id")) {
        res.status(409).json({ message: "That national ID belongs to a different applicant." });
      } else {
        res.status(409).json({ message: "This applicant already exists." });
      }
    } else {
      console.error(err);
      res.status(500).json({ message: "Database error" });
    }
  } finally {
    conn.release();
  }
}

export async function changeApplicationStatus(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  const status = asText(req.body?.status);
  const comment = asText(req.body?.comment);

  if (!id) {
    res.status(400).json({ message: "Invalid application id." });
    return;
  }
  if (!APPLICATION_STATUSES.includes(status)) {
    res.status(400).json({ message: "Invalid status." });
    return;
  }
  if (status === "Hired") {
    res.status(400).json({
      message: "An applicant becomes Hired when they are converted to an employee.",
    });
    return;
  }
  if ((status === "Rejected" || status === "Withdrawn") && comment.length < 3) {
    res.status(400).json({ message: "Please give a reason (at least 3 characters)." });
    return;
  }
  if (comment.length > 255) {
    res.status(400).json({ message: "The comment must be 255 characters or fewer." });
    return;
  }

  const conn = await pool.getConnection();
  try {
    const [found] = await conn.query<RowDataPacket[]>(
      "SELECT status FROM applications WHERE application_id = ?",
      [id]
    );
    const current = found[0];
    if (!current) {
      res.status(404).json({ message: "Application not found." });
      return;
    }
    if (current.status === status) {
      res.json({ message: "No changes", status });
      return;
    }
    const allowed = NEXT_STATUSES[current.status as string] ?? [];
    if (!allowed.includes(status)) {
      res.status(400).json({
        message: `An application that is ${current.status} cannot move to ${status}.`,
      });
      return;
    }

    await conn.beginTransaction();
    await conn.query("UPDATE applications SET status = ? WHERE application_id = ?", [status, id]);
    await conn.query(
      `INSERT INTO application_history (application_id, from_status, to_status, comment, changed_by)
       VALUES (?, ?, ?, ?, ?)`,
      [id, current.status, status, comment || null, req.user?.userId ?? null]
    );
    await conn.commit();
    res.json({ message: `Application is now ${status}`, status });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: "Database error" });
  } finally {
    conn.release();
  }
}
/* ---------- PDF report of applicants (HR) ---------- */

export async function exportApplicationsPdf(req: AuthedRequest, res: Response): Promise<void> {
  const vacancyId = parseInt(String(req.params.id), 10);
  const status = asText(req.query.status);

  if (!vacancyId) {
    res.status(400).json({ message: "Invalid vacancy id." });
    return;
  }
  if (status && !APPLICATION_STATUSES.includes(status)) {
    res.status(400).json({ message: "Invalid stage." });
    return;
  }

  let vacancy: RowDataPacket | undefined;
  let rows: RowDataPacket[] = [];
  let generatedBy = "";

  try {
    const [v] = await pool.query<RowDataPacket[]>(
      `SELECT v.title, v.openings, v.closing_date, v.status, d.department_name
       FROM vacancies v JOIN departments d ON d.department_id = v.department_id
       WHERE v.vacancy_id = ?`,
      [vacancyId]
    );
    vacancy = v[0];
    if (!vacancy) {
      res.status(404).json({ message: "Vacancy not found." });
      return;
    }

    const where = ["a.vacancy_id = ?"];
    const params: (string | number)[] = [vacancyId];
    if (status) {
      where.push("a.status = ?");
      params.push(status);
    }

    const [r] = await pool.query<RowDataPacket[]>(
      `SELECT a.status, a.applied_date, p.full_name, p.email, p.phone,
              (SELECT MAX(i.score) FROM interviews i WHERE i.application_id = a.application_id) AS best_score
       FROM applications a
       JOIN applicants p ON p.applicant_id = a.applicant_id
       WHERE ${where.join(" AND ")}
       ORDER BY FIELD(a.status, 'Applied','Shortlisted','Interview','Selected','Hired','Rejected','Withdrawn'),
                p.full_name`,
      params
    );
    rows = r;

    const [u] = await pool.query<RowDataPacket[]>(
      "SELECT full_name FROM users WHERE user_id = ?",
      [req.user!.userId]
    );
    generatedBy = u[0]?.full_name ?? "";
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
    return;
  }

  // Everything is validated, so it is safe to start sending the file
  const safeTitle =
    String(vacancy.title).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "vacancy";
  const filename = `applicants-${safeTitle}-${(status || "all").toLowerCase()}-${todayString()}.pdf`;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 40 });
  doc.pipe(res);

  doc.font("Helvetica-Bold").fontSize(18).text("Applicants report");
  doc.moveDown(0.4);
  doc.font("Helvetica").fontSize(11);
  doc.text(`Vacancy: ${vacancy.title}`);
  doc.text(`Department: ${vacancy.department_name}`);
  doc.text(`Openings: ${vacancy.openings}    Vacancy status: ${vacancy.status}`);
  doc.text(`Closing date: ${vacancy.closing_date ?? "No deadline"}`);
  doc.text(`Stage shown: ${status || "All stages"}`);
  doc.text(`Generated on ${todayString()}${generatedBy ? " by " + generatedBy : ""}`);

  if (!status && rows.length) {
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
    doc.moveDown(0.4);
    doc.text(
      "Summary: " + [...counts.entries()].map(([s, n]) => `${s} ${n}`).join("  |  ") + `  |  Total ${rows.length}`
    );
  }

  const cols = [
    { label: "#", w: 30 },
    { label: "Name", w: 150 },
    { label: "Email", w: 190 },
    { label: "Phone", w: 100 },
    { label: "Applied on", w: 80 },
    { label: "Stage", w: 90 },
    { label: "Best score", w: 60 },
  ];
  const left = 40;
  const totalWidth = cols.reduce((sum, c) => sum + c.w, 0);
  let y = doc.y + 14;

  const drawHeader = () => {
    doc.font("Helvetica-Bold").fontSize(9);
    let x = left;
    for (const c of cols) {
      doc.text(c.label, x, y, { width: c.w - 6, lineBreak: false });
      x += c.w;
    }
    y += 14;
    doc.moveTo(left, y).lineTo(left + totalWidth, y).stroke();
    y += 5;
    doc.font("Helvetica").fontSize(9);
  };

  drawHeader();

  if (!rows.length) {
    doc.text("No applicants in this stage.", left, y);
  }

  rows.forEach((r, i) => {
    if (y > doc.page.height - 60) {
      doc.addPage();
      y = 40;
      drawHeader();
    }
    const cells = [
      String(i + 1),
      r.full_name,
      r.email,
      r.phone ?? "",
      r.applied_date,
      r.status,
      r.best_score === null || r.best_score === undefined ? "" : String(r.best_score),
    ];
    let x = left;
    cells.forEach((text, idx) => {
      doc.text(String(text), x, y, { width: cols[idx].w - 6, lineBreak: false, ellipsis: true });
      x += cols[idx].w;
    });
    y += 16;
  });

  doc.end();
}
/* ---------- convert a Selected applicant into an employee (HR) ---------- */

function stop(status: number, message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

export async function hireApplicant(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  const b = req.body ?? {};
  const password = typeof b.password === "string" ? b.password : "";
  const role = asText(b.role) || "Employee";
  const hireDate = asText(b.hireDate) || todayString();
  const departmentInput = parseInt(asText(String(b.departmentId ?? "")), 10) || null;
  const jobTitleInput = asText(b.jobTitle) || null;
  const managerId = parseInt(asText(String(b.managerId ?? "")), 10) || null;

  const errors: string[] = [];
  if (!id) errors.push("Invalid application id.");
  if (password.length < 8) errors.push("The temporary password must be at least 8 characters.");
  if (password.length > 72) errors.push("The temporary password must be 72 characters or fewer.");
  if (!["Employee", "Manager"].includes(role)) errors.push("Role must be Employee or Manager.");
  if (!isValidDate(hireDate)) errors.push("Hire date must be YYYY-MM-DD.");
  if (jobTitleInput && jobTitleInput.length > 100) errors.push("Job title must be 100 characters or fewer.");
  if (errors.length) {
    res.status(400).json({ message: errors[0], errors });
    return;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // FOR UPDATE locks the application, so a double click cannot hire the same person twice
    const [found] = await conn.query<RowDataPacket[]>(
      `SELECT a.application_id, a.status, a.employee_id, a.vacancy_id,
              p.full_name, p.email, p.phone, p.national_id, p.gender, p.date_of_birth, p.address,
              v.title, v.department_id, v.openings
       FROM applications a
       JOIN applicants p ON p.applicant_id = a.applicant_id
       JOIN vacancies v ON v.vacancy_id = a.vacancy_id
       WHERE a.application_id = ?
       FOR UPDATE`,
      [id]
    );
    const app = found[0];
    if (!app) throw stop(404, "Application not found.");
    if (app.employee_id) throw stop(409, "This applicant has already been converted to an employee.");
    if (app.status !== "Selected") {
      throw stop(400, `Only Selected applicants can be hired. This one is ${app.status}.`);
    }

    const [cnt] = await conn.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS hired FROM applications WHERE vacancy_id = ? AND status = 'Hired'",
      [app.vacancy_id]
    );
    const hiredSoFar = Number(cnt[0].hired);
    if (hiredSoFar >= Number(app.openings)) {
      throw stop(400, "All openings for this vacancy are already filled.");
    }

    const email = String(app.email).toLowerCase();
    const [dup] = await conn.query<RowDataPacket[]>(
      "SELECT employee_id FROM employees WHERE email = ?",
      [email]
    );
    if (dup[0]) throw stop(409, "An employee with this email already exists.");

    const departmentId = departmentInput ?? Number(app.department_id);
    const jobTitle = jobTitleInput ?? String(app.title).slice(0, 100);

    const [emp] = await conn.query<ResultSetHeader>(
      `INSERT INTO employees
         (full_name, email, phone, national_id, gender, date_of_birth, address,
          department_id, job_title, hire_date, manager_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [app.full_name, email, app.phone, app.national_id, app.gender, app.date_of_birth,
       app.address, departmentId, jobTitle, hireDate, managerId]
    );
    const employeeId = emp.insertId;
    const code = `EMP-${String(employeeId).padStart(4, "0")}`;
    await conn.query("UPDATE employees SET employee_code = ? WHERE employee_id = ?", [code, employeeId]);

    const hash = await bcrypt.hash(password, 10);
    await conn.query(
      "INSERT INTO users (employee_id, full_name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)",
      [employeeId, app.full_name, email, hash, role]
    );

    await conn.query(
      `INSERT INTO leave_balances (employee_id, leave_type_id, year, days_allocated, days_used)
       SELECT ?, leave_type_id, YEAR(CURDATE()), days_allowed_per_year, 0 FROM leave_types`,
      [employeeId]
    );

    await conn.query(
      "INSERT INTO employee_history (employee_id, change_type, new_values, changed_by) VALUES (?, 'created', ?, ?)",
      [
        employeeId,
        JSON.stringify({
          fullName: app.full_name, email, departmentId, jobTitle, hireDate, managerId, role,
          source: "recruitment", applicationId: id,
        }),
        req.user?.userId ?? null,
      ]
    );

    await conn.query(
      "UPDATE applications SET status = 'Hired', employee_id = ? WHERE application_id = ?",
      [employeeId, id]
    );
    await conn.query(
      `INSERT INTO application_history (application_id, from_status, to_status, comment, changed_by)
       VALUES (?, 'Selected', 'Hired', ?, ?)`,
      [id, `Hired as ${code}`, req.user?.userId ?? null]
    );

    const filled = hiredSoFar + 1 >= Number(app.openings);
    if (filled) {
      await conn.query("UPDATE vacancies SET status = 'Filled' WHERE vacancy_id = ?", [app.vacancy_id]);
    }

    await conn.commit();
    res.status(201).json({
      message: "Applicant hired and employee record created",
      employee_id: employeeId,
      employee_code: code,
      vacancy_filled: filled,
    });
  } catch (err) {
    await conn.rollback();
    const known = (err as { status?: unknown }).status;
    if (typeof known === "number") {
      res.status(known).json({ message: (err as Error).message });
    } else {
      const e = err as { code?: string; sqlMessage?: string };
      if (e.code === "ER_DUP_ENTRY") {
        const field = e.sqlMessage?.includes("national_id") ? "national ID" : "email";
        res.status(409).json({ message: `An employee with this ${field} already exists.` });
      } else if (e.code === "ER_NO_REFERENCED_ROW_2") {
        res.status(400).json({ message: "Invalid department or manager." });
      } else {
        console.error(err);
        res.status(500).json({ message: "Database error" });
      }
    }
  } finally {
    conn.release();
  }
}
/* ---------- interviews ---------- */

const INTERVIEW_RESULTS = ["Pending", "Passed", "Failed"];
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/;

function parseDateTime(value: string): Date | null {
  if (!DATETIME_RE.test(value)) return null;
  const d = new Date(value.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d;
}

function toSqlDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

export async function listInterviews(req: AuthedRequest, res: Response): Promise<void> {
  const applicationId = parseInt(String(req.params.id), 10);
  if (!applicationId) {
    res.status(400).json({ message: "Invalid application id." });
    return;
  }

  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT i.interview_id, i.interview_at, i.location, i.result, i.score, i.feedback,
              i.interviewer_id, e.full_name AS interviewer_name
       FROM interviews i
       LEFT JOIN employees e ON e.employee_id = i.interviewer_id
       WHERE i.application_id = ?
       ORDER BY i.interview_at DESC`,
      [applicationId]
    );
    res.json({ data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function scheduleInterview(req: AuthedRequest, res: Response): Promise<void> {
  const applicationId = parseInt(String(req.params.id), 10);
  const b = req.body ?? {};
  const when = parseDateTime(asText(b.interviewAt));
  const location = asText(b.location) || null;
  const interviewerId = parseInt(asText(String(b.interviewerId ?? "")), 10) || null;

  const errors: string[] = [];
  if (!applicationId) errors.push("Invalid application id.");
  if (!when) errors.push("Interview date and time are required (YYYY-MM-DD HH:MM).");
  else if (when.getTime() < Date.now()) errors.push("The interview time must be in the future.");
  if (location && location.length > 150) errors.push("Location must be 150 characters or fewer.");
  if (errors.length) {
    res.status(400).json({ message: errors[0], errors });
    return;
  }

  const conn = await pool.getConnection();
  try {
    const [found] = await conn.query<RowDataPacket[]>(
      "SELECT status FROM applications WHERE application_id = ?",
      [applicationId]
    );
    const app = found[0];
    if (!app) {
      res.status(404).json({ message: "Application not found." });
      return;
    }
    if (app.status !== "Shortlisted" && app.status !== "Interview") {
      res.status(400).json({
        message: `Interviews can only be scheduled for shortlisted applicants. This one is ${app.status}.`,
      });
      return;
    }

    if (interviewerId) {
      const [emp] = await conn.query<RowDataPacket[]>(
        "SELECT employee_id FROM employees WHERE employee_id = ? AND status = 'Active'",
        [interviewerId]
      );
      if (!emp[0]) {
        res.status(400).json({ message: "The interviewer must be an active employee." });
        return;
      }
    }

    await conn.beginTransaction();
    const [ins] = await conn.query<ResultSetHeader>(
      `INSERT INTO interviews (application_id, interview_at, location, interviewer_id, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [applicationId, toSqlDateTime(when!), location, interviewerId, req.user?.userId ?? null]
    );

    // The first interview moves the application to the Interview stage
    if (app.status === "Shortlisted") {
      await conn.query("UPDATE applications SET status = 'Interview' WHERE application_id = ?", [
        applicationId,
      ]);
      await conn.query(
        `INSERT INTO application_history (application_id, from_status, to_status, comment, changed_by)
         VALUES (?, 'Shortlisted', 'Interview', 'Interview scheduled', ?)`,
        [applicationId, req.user?.userId ?? null]
      );
    }

    await conn.commit();
    res.status(201).json({ message: "Interview scheduled", interview_id: ins.insertId });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: "Database error" });
  } finally {
    conn.release();
  }
}

export async function recordInterviewResult(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  const b = req.body ?? {};
  const result = asText(b.result);
  const feedback = asText(b.feedback) || null;
  const scoreRaw = b.score === undefined || b.score === null || b.score === "" ? null : Number(b.score);

  const errors: string[] = [];
  if (!id) errors.push("Invalid interview id.");
  if (!INTERVIEW_RESULTS.includes(result)) errors.push("Result must be Pending, Passed or Failed.");
  if (scoreRaw !== null && (!Number.isInteger(scoreRaw) || scoreRaw < 0 || scoreRaw > 100)) {
    errors.push("Score must be a whole number from 0 to 100.");
  }
  if (feedback && feedback.length > 2000) errors.push("Feedback is too long.");
  if (errors.length) {
    res.status(400).json({ message: errors[0], errors });
    return;
  }

  try {
    const [found] = await pool.query<RowDataPacket[]>(
      "SELECT interview_at FROM interviews WHERE interview_id = ?",
      [id]
    );
    if (!found[0]) {
      res.status(404).json({ message: "Interview not found." });
      return;
    }
    if (result !== "Pending" && new Date(String(found[0].interview_at).replace(" ", "T")).getTime() > Date.now()) {
      res.status(400).json({ message: "You cannot record a result before the interview has taken place." });
      return;
    }

    await pool.query("UPDATE interviews SET result = ?, score = ?, feedback = ? WHERE interview_id = ?", [
      result,
      scoreRaw,
      feedback,
      id,
    ]);
    res.json({ message: "Interview result saved", result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}