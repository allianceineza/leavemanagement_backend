import type { Response } from "express";
import type { RowDataPacket, ResultSetHeader } from "mysql2";
import { pool } from "../db";
import type { AuthedRequest } from "../middleware/auth";

const CATEGORIES = ["Sport", "Social event", "Training", "Other"];
const STATUSES = ["Open", "Closed", "Cancelled", "Completed"];
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/;

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseDateTime(value: string): Date | null {
  if (!DATETIME_RE.test(value)) return null;
  const d = new Date(value.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? null : d;
}

function toSql(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

// Whole numbers only; empty means "no limit"
function parseLimit(value: unknown, max: number): { ok: boolean; value: number | null } {
  if (value === undefined || value === null || value === "") return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) return { ok: false, value: null };
  return { ok: true, value: n };
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

// The date and time a registration closes: the deadline, or the start when there is none
const CLOSES_SQL = "COALESCE(a.registration_deadline, a.starts_at)";

/* ---------- list and view ---------- */

export async function listActivities(req: AuthedRequest, res: Response): Promise<void> {
  const page = Math.max(parseInt(asText(req.query.page), 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(asText(req.query.limit), 10) || 12, 1), 100);
  const search = asText(req.query.search);
  const category = asText(req.query.category);
  const status = asText(req.query.status);
  const when = asText(req.query.when); // upcoming | past

  try {
    const me = await myEmployee(req.user!.userId);
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (search) {
      where.push("a.title LIKE ?");
      params.push(`%${search}%`);
    }
    if (CATEGORIES.includes(category)) {
      where.push("a.category = ?");
      params.push(category);
    }
    if (STATUSES.includes(status)) {
      where.push("a.status = ?");
      params.push(status);
    }
    if (when === "upcoming") where.push("COALESCE(a.ends_at, a.starts_at) >= NOW()");
    if (when === "past") where.push("COALESCE(a.ends_at, a.starts_at) < NOW()");
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT a.activity_id, a.title, a.category, a.location, a.starts_at, a.ends_at,
              a.registration_deadline, a.max_participants, a.uses_teams, a.status,
              (SELECT COUNT(*) FROM activity_registrations r
                 WHERE r.activity_id = a.activity_id AND r.status = 'Registered') AS registered,
              (SELECT r.status FROM activity_registrations r
                 WHERE r.activity_id = a.activity_id AND r.employee_id = ?) AS my_status
       FROM activities a
       ${whereSql}
       ORDER BY (a.status = 'Open') DESC, a.starts_at DESC
       LIMIT ? OFFSET ?`,
      [me?.employee_id ?? 0, ...params, limit, (page - 1) * limit]
    );
    const [count] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM activities a ${whereSql}`,
      params
    );
    const total = Number(count[0].total);

    res.json({
      data: rows.map((r) => ({
        ...r,
        registered: Number(r.registered),
        uses_teams: Number(r.uses_teams),
      })),
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function getActivity(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  if (!id) {
    res.status(400).json({ message: "Invalid activity id." });
    return;
  }

  try {
    const me = await myEmployee(req.user!.userId);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT a.activity_id, a.title, a.category, a.description, a.location, a.starts_at,
              a.ends_at, a.registration_deadline, a.max_participants, a.uses_teams, a.status,
              u.full_name AS created_by_name,
              (SELECT COUNT(*) FROM activity_registrations r
                 WHERE r.activity_id = a.activity_id AND r.status = 'Registered') AS registered
       FROM activities a LEFT JOIN users u ON u.user_id = a.created_by
       WHERE a.activity_id = ?`,
      [id]
    );
    const activity = rows[0];
    if (!activity) {
      res.status(404).json({ message: "Activity not found." });
      return;
    }

    const [mine] = await pool.query<RowDataPacket[]>(
      `SELECT r.status, r.team_id, t.name AS team_name
       FROM activity_registrations r LEFT JOIN activity_teams t ON t.team_id = r.team_id
       WHERE r.activity_id = ? AND r.employee_id = ?`,
      [id, me?.employee_id ?? 0]
    );

    res.json({
      data: {
        ...activity,
        registered: Number(activity.registered),
        uses_teams: Number(activity.uses_teams),
        my_registration: mine[0] ?? null,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

/* ---------- create and edit (HR) ---------- */

export async function createActivity(req: AuthedRequest, res: Response): Promise<void> {
  const b = req.body ?? {};
  const title = asText(b.title);
  const category = asText(b.category) || "Sport";
  const description = asText(b.description) || null;
  const location = asText(b.location) || null;
  const starts = parseDateTime(asText(b.startsAt));
  const ends = asText(b.endsAt) ? parseDateTime(asText(b.endsAt)) : null;
  const deadline = asText(b.registrationDeadline) ? parseDateTime(asText(b.registrationDeadline)) : null;
  const max = parseLimit(b.maxParticipants, 10000);
  const usesTeams = b.usesTeams ? 1 : 0;

  const errors: string[] = [];
  if (!title) errors.push("A title is required.");
  if (title.length > 150) errors.push("The title must be 150 characters or fewer.");
  if (!CATEGORIES.includes(category)) errors.push("Invalid category.");
  if (!starts) errors.push("The start date and time are required (YYYY-MM-DD HH:MM).");
  else if (starts.getTime() < Date.now()) errors.push("The start time must be in the future.");
  if (asText(b.endsAt) && !ends) errors.push("The end date and time are not valid.");
  if (starts && ends && ends.getTime() < starts.getTime()) errors.push("The end cannot be before the start.");
  if (asText(b.registrationDeadline) && !deadline) errors.push("The registration deadline is not valid.");
  if (starts && deadline && deadline.getTime() > starts.getTime()) {
    errors.push("The registration deadline cannot be after the start.");
  }
  if (location && location.length > 150) errors.push("The location must be 150 characters or fewer.");
  if (!max.ok) errors.push("The participant limit must be a whole number from 1 to 10000.");
  if (errors.length) {
    res.status(400).json({ message: errors[0], errors });
    return;
  }

  try {
    const [r] = await pool.query<ResultSetHeader>(
      `INSERT INTO activities
         (title, category, description, location, starts_at, ends_at, registration_deadline,
          max_participants, uses_teams, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [title, category, description, location, toSql(starts!), ends ? toSql(ends) : null,
       deadline ? toSql(deadline) : null, max.value, usesTeams, req.user?.userId ?? null]
    );
    res.status(201).json({ message: "Activity created", activity_id: r.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function updateActivity(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  const b = req.body ?? {};
  if (!id) {
    res.status(400).json({ message: "Invalid activity id." });
    return;
  }

  try {
    const [found] = await pool.query<RowDataPacket[]>(
      `SELECT a.*,
              (SELECT COUNT(*) FROM activity_registrations r
                 WHERE r.activity_id = a.activity_id AND r.status = 'Registered') AS registered,
              (SELECT COUNT(*) FROM activity_teams t WHERE t.activity_id = a.activity_id) AS team_count
       FROM activities a WHERE a.activity_id = ?`,
      [id]
    );
    const cur = found[0];
    if (!cur) {
      res.status(404).json({ message: "Activity not found." });
      return;
    }
    if (cur.status === "Cancelled" || cur.status === "Completed") {
      res.status(400).json({ message: `A ${cur.status.toLowerCase()} activity cannot be edited.` });
      return;
    }

    const asDate = (v: unknown, current: unknown): Date | null | "bad" => {
      if (v === undefined) return current ? new Date(String(current).replace(" ", "T")) : null;
      const text = asText(v);
      if (!text) return null;
      return parseDateTime(text) ?? "bad";
    };

    const title = b.title === undefined ? cur.title : asText(b.title);
    const category = b.category === undefined ? cur.category : asText(b.category);
    const description = b.description === undefined ? cur.description : asText(b.description) || null;
    const location = b.location === undefined ? cur.location : asText(b.location) || null;
    const starts = asDate(b.startsAt, cur.starts_at);
    const ends = asDate(b.endsAt, cur.ends_at);
    const deadline = asDate(b.registrationDeadline, cur.registration_deadline);
    const max = b.maxParticipants === undefined
      ? { ok: true, value: cur.max_participants === null ? null : Number(cur.max_participants) }
      : parseLimit(b.maxParticipants, 10000);
    const usesTeams = b.usesTeams === undefined ? Number(cur.uses_teams) : b.usesTeams ? 1 : 0;

    const errors: string[] = [];
    if (!title || title.length > 150) errors.push("A title is required, up to 150 characters.");
    if (!CATEGORIES.includes(category)) errors.push("Invalid category.");
    if (starts === "bad" || starts === null) errors.push("The start date and time are not valid.");
    if (ends === "bad") errors.push("The end date and time are not valid.");
    if (deadline === "bad") errors.push("The registration deadline is not valid.");
    if (starts instanceof Date && ends instanceof Date && ends.getTime() < starts.getTime()) {
      errors.push("The end cannot be before the start.");
    }
    if (starts instanceof Date && deadline instanceof Date && deadline.getTime() > starts.getTime()) {
      errors.push("The registration deadline cannot be after the start.");
    }
    if (!max.ok) errors.push("The participant limit must be a whole number from 1 to 10000.");
    if (max.ok && max.value !== null && max.value < Number(cur.registered)) {
      errors.push(`The limit cannot be lower than the ${cur.registered} people already registered.`);
    }
    if (usesTeams === 0 && Number(cur.team_count) > 0) {
      errors.push("Remove the teams before turning team play off.");
    }
    if (errors.length) {
      res.status(400).json({ message: errors[0], errors });
      return;
    }

    await pool.query(
      `UPDATE activities
       SET title = ?, category = ?, description = ?, location = ?, starts_at = ?, ends_at = ?,
           registration_deadline = ?, max_participants = ?, uses_teams = ?
       WHERE activity_id = ?`,
      [title, category, description, location, toSql(starts as Date),
       ends instanceof Date ? toSql(ends) : null,
       deadline instanceof Date ? toSql(deadline) : null, max.value, usesTeams, id]
    );
    res.json({ message: "Activity updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function changeActivityStatus(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  const status = asText(req.body?.status);
  if (!id) {
    res.status(400).json({ message: "Invalid activity id." });
    return;
  }
  if (!STATUSES.includes(status)) {
    res.status(400).json({ message: "Status must be Open, Closed, Cancelled or Completed." });
    return;
  }

  try {
    const [found] = await pool.query<RowDataPacket[]>(
      "SELECT status, starts_at FROM activities WHERE activity_id = ?",
      [id]
    );
    const cur = found[0];
    if (!cur) {
      res.status(404).json({ message: "Activity not found." });
      return;
    }
    if (cur.status === status) {
      res.json({ message: "No changes", status });
      return;
    }
    if (cur.status === "Cancelled" || cur.status === "Completed") {
      res.status(400).json({ message: `A ${cur.status.toLowerCase()} activity cannot be changed.` });
      return;
    }
    if (status === "Open" && new Date(String(cur.starts_at).replace(" ", "T")).getTime() < Date.now()) {
      res.status(400).json({ message: "An activity that has already started cannot be reopened." });
      return;
    }

    await pool.query("UPDATE activities SET status = ? WHERE activity_id = ?", [status, id]);
    res.json({ message: `Activity is now ${status}`, status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function deleteActivity(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  if (!id) {
    res.status(400).json({ message: "Invalid activity id." });
    return;
  }

  try {
    const [found] = await pool.query<RowDataPacket[]>(
      `SELECT a.activity_id,
              (SELECT COUNT(*) FROM activity_registrations r WHERE r.activity_id = a.activity_id) AS regs
       FROM activities a WHERE a.activity_id = ?`,
      [id]
    );
    if (!found[0]) {
      res.status(404).json({ message: "Activity not found." });
      return;
    }
    if (Number(found[0].regs) > 0) {
      res.status(400).json({
        message: "This activity has registrations, so it cannot be deleted. Cancel it instead.",
      });
      return;
    }
    await pool.query("DELETE FROM activities WHERE activity_id = ?", [id]);
    res.json({ message: "Activity deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

/* ---------- registration ---------- */

async function register(
  activityId: number,
  employeeId: number,
  registeredBy: number
): Promise<{ status: number; message: string }> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // FOR UPDATE locks the activity, so two people cannot take the last place together
    const [act] = await conn.query<RowDataPacket[]>(
      `SELECT a.status, a.max_participants, ${CLOSES_SQL} AS closes_at
       FROM activities a WHERE a.activity_id = ? FOR UPDATE`,
      [activityId]
    );
    if (!act[0]) {
      await conn.rollback();
      return { status: 404, message: "Activity not found." };
    }
    if (act[0].status !== "Open") {
      await conn.rollback();
      return { status: 400, message: "This activity is not open for registration." };
    }
    if (new Date(String(act[0].closes_at).replace(" ", "T")).getTime() < Date.now()) {
      await conn.rollback();
      return { status: 400, message: "Registration for this activity has closed." };
    }

    const [emp] = await conn.query<RowDataPacket[]>(
      "SELECT status FROM employees WHERE employee_id = ?",
      [employeeId]
    );
    if (!emp[0] || emp[0].status !== "Active") {
      await conn.rollback();
      return { status: 400, message: "Only active employees can register." };
    }

    const [existing] = await conn.query<RowDataPacket[]>(
      "SELECT registration_id, status FROM activity_registrations WHERE activity_id = ? AND employee_id = ?",
      [activityId, employeeId]
    );
    if (existing[0] && existing[0].status === "Registered") {
      await conn.rollback();
      return { status: 409, message: "Already registered for this activity." };
    }

    if (act[0].max_participants !== null) {
      const [cnt] = await conn.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS n FROM activity_registrations WHERE activity_id = ? AND status = 'Registered'",
        [activityId]
      );
      if (Number(cnt[0].n) >= Number(act[0].max_participants)) {
        await conn.rollback();
        return { status: 400, message: "This activity is full." };
      }
    }

    if (existing[0]) {
      await conn.query(
        `UPDATE activity_registrations
         SET status = 'Registered', cancelled_at = NULL, team_id = NULL, registered_at = NOW(), registered_by = ?
         WHERE registration_id = ?`,
        [registeredBy, existing[0].registration_id]
      );
    } else {
      await conn.query(
        "INSERT INTO activity_registrations (activity_id, employee_id, registered_by) VALUES (?, ?, ?)",
        [activityId, employeeId, registeredBy]
      );
    }
    await conn.commit();
    return { status: 201, message: "Registered" };
  } catch (err) {
    await conn.rollback();
    console.error(err);
    return { status: 500, message: "Database error" };
  } finally {
    conn.release();
  }
}

export async function registerMyself(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  if (!id) {
    res.status(400).json({ message: "Invalid activity id." });
    return;
  }
  const me = await myEmployee(req.user!.userId);
  if (!me) {
    res.status(404).json({ message: "No employee profile is linked to this account." });
    return;
  }
  const result = await register(id, me.employee_id, req.user!.userId);
  res.status(result.status).json({ message: result.message });
}

export async function registerSomeone(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  const employeeId = parseInt(asText(String(req.body?.employeeId ?? "")), 10);
  if (!id || !employeeId) {
    res.status(400).json({ message: "Choose an activity and an employee." });
    return;
  }
  const result = await register(id, employeeId, req.user!.userId);
  res.status(result.status).json({ message: result.message });
}

export async function cancelRegistration(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  if (!id) {
    res.status(400).json({ message: "Invalid activity id." });
    return;
  }

  try {
    const me = await myEmployee(req.user!.userId);
    if (!me) {
      res.status(404).json({ message: "No employee profile is linked to this account." });
      return;
    }

    // Cancelling is for your own registration. An HR person removing another is separate below.
    const [act] = await pool.query<RowDataPacket[]>(
      "SELECT status, starts_at FROM activities WHERE activity_id = ?",
      [id]
    );
    if (!act[0]) {
      res.status(404).json({ message: "Activity not found." });
      return;
    }
    if (new Date(String(act[0].starts_at).replace(" ", "T")).getTime() < Date.now()) {
      res.status(400).json({ message: "This activity has already started, so you cannot cancel now." });
      return;
    }

    const [r] = await pool.query<ResultSetHeader>(
      `UPDATE activity_registrations
       SET status = 'Cancelled', cancelled_at = NOW(), team_id = NULL
       WHERE activity_id = ? AND employee_id = ? AND status = 'Registered'`,
      [id, me.employee_id]
    );
    if (!r.affectedRows) {
      res.status(404).json({ message: "You are not registered for this activity." });
      return;
    }
    res.json({ message: "Your registration was cancelled." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function removeParticipant(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  const employeeId = parseInt(String(req.params.employeeId), 10);
  if (!id || !employeeId) {
    res.status(400).json({ message: "Invalid activity or employee." });
    return;
  }
  try {
    const [r] = await pool.query<ResultSetHeader>(
      `UPDATE activity_registrations
       SET status = 'Cancelled', cancelled_at = NOW(), team_id = NULL
       WHERE activity_id = ? AND employee_id = ? AND status = 'Registered'`,
      [id, employeeId]
    );
    if (!r.affectedRows) {
      res.status(404).json({ message: "That person is not registered for this activity." });
      return;
    }
    res.json({ message: "Participant removed." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function listParticipants(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  if (!id) {
    res.status(400).json({ message: "Invalid activity id." });
    return;
  }
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT r.employee_id, e.full_name, e.employee_code, d.department_name,
              r.team_id, t.name AS team_name, r.registered_at
       FROM activity_registrations r
       JOIN employees e ON e.employee_id = r.employee_id
       JOIN departments d ON d.department_id = e.department_id
       LEFT JOIN activity_teams t ON t.team_id = r.team_id
       WHERE r.activity_id = ? AND r.status = 'Registered'
       ORDER BY e.full_name`,
      [id]
    );
    res.json({ data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function listMyActivities(req: AuthedRequest, res: Response): Promise<void> {
  try {
    const me = await myEmployee(req.user!.userId);
    if (!me) {
      res.status(404).json({ message: "No employee profile is linked to this account." });
      return;
    }
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT a.activity_id, a.title, a.category, a.location, a.starts_at, a.status,
              r.status AS my_status, t.name AS team_name
       FROM activity_registrations r
       JOIN activities a ON a.activity_id = r.activity_id
       LEFT JOIN activity_teams t ON t.team_id = r.team_id
       WHERE r.employee_id = ? AND r.status = 'Registered'
       ORDER BY a.starts_at DESC`,
      [me.employee_id]
    );
    res.json({ data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

/* ---------- teams (HR) ---------- */

export async function listTeams(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  if (!id) {
    res.status(400).json({ message: "Invalid activity id." });
    return;
  }
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT t.team_id, t.name, t.max_members, t.captain_id, c.full_name AS captain_name,
              (SELECT COUNT(*) FROM activity_registrations r
                 WHERE r.team_id = t.team_id AND r.status = 'Registered') AS members
       FROM activity_teams t LEFT JOIN employees c ON c.employee_id = t.captain_id
       WHERE t.activity_id = ? ORDER BY t.name`,
      [id]
    );
    res.json({ data: rows.map((r) => ({ ...r, members: Number(r.members) })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function createTeam(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  const name = asText(req.body?.name);
  const max = parseLimit(req.body?.maxMembers, 1000);

  if (!id) {
    res.status(400).json({ message: "Invalid activity id." });
    return;
  }
  if (!name || name.length > 100) {
    res.status(400).json({ message: "A team name is required, up to 100 characters." });
    return;
  }
  if (!max.ok) {
    res.status(400).json({ message: "The member limit must be a whole number from 1 to 1000." });
    return;
  }

  try {
    const [act] = await pool.query<RowDataPacket[]>(
      "SELECT uses_teams, status FROM activities WHERE activity_id = ?",
      [id]
    );
    if (!act[0]) {
      res.status(404).json({ message: "Activity not found." });
      return;
    }
    if (!Number(act[0].uses_teams)) {
      res.status(400).json({ message: "This activity does not use teams." });
      return;
    }
    if (act[0].status === "Cancelled" || act[0].status === "Completed") {
      res.status(400).json({ message: `Teams cannot be added to a ${act[0].status.toLowerCase()} activity.` });
      return;
    }

    const [r] = await pool.query<ResultSetHeader>(
      "INSERT INTO activity_teams (activity_id, name, max_members) VALUES (?, ?, ?)",
      [id, name, max.value]
    );
    res.status(201).json({ message: "Team created", team_id: r.insertId });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "ER_DUP_ENTRY") {
      res.status(409).json({ message: "A team with this name already exists in this activity." });
    } else {
      console.error(err);
      res.status(500).json({ message: "Database error" });
    }
  }
}

export async function updateTeam(req: AuthedRequest, res: Response): Promise<void> {
  const teamId = parseInt(String(req.params.teamId), 10);
  const b = req.body ?? {};
  if (!teamId) {
    res.status(400).json({ message: "Invalid team id." });
    return;
  }

  try {
    const [found] = await pool.query<RowDataPacket[]>(
      `SELECT t.activity_id, t.name, t.max_members, t.captain_id,
              (SELECT COUNT(*) FROM activity_registrations r
                 WHERE r.team_id = t.team_id AND r.status = 'Registered') AS members
       FROM activity_teams t WHERE t.team_id = ?`,
      [teamId]
    );
    const cur = found[0];
    if (!cur) {
      res.status(404).json({ message: "Team not found." });
      return;
    }

    const name = b.name === undefined ? cur.name : asText(b.name);
    const max = b.maxMembers === undefined
      ? { ok: true, value: cur.max_members === null ? null : Number(cur.max_members) }
      : parseLimit(b.maxMembers, 1000);
    if (!name || name.length > 100) {
      res.status(400).json({ message: "A team name is required, up to 100 characters." });
      return;
    }
    if (!max.ok) {
      res.status(400).json({ message: "The member limit must be a whole number from 1 to 1000." });
      return;
    }
    if (max.value !== null && max.value < Number(cur.members)) {
      res.status(400).json({ message: `The limit cannot be lower than the ${cur.members} members already in the team.` });
      return;
    }

    let captainId: number | null = cur.captain_id;
    if (b.captainId !== undefined) {
      const cap = parseInt(asText(String(b.captainId ?? "")), 10) || null;
      if (cap) {
        // The captain must be a registered member of this very team
        const [ok] = await pool.query<RowDataPacket[]>(
          `SELECT registration_id FROM activity_registrations
           WHERE team_id = ? AND employee_id = ? AND status = 'Registered'`,
          [teamId, cap]
        );
        if (!ok[0]) {
          res.status(400).json({ message: "The captain must be a registered member of this team." });
          return;
        }
      }
      captainId = cap;
    }

    await pool.query(
      "UPDATE activity_teams SET name = ?, max_members = ?, captain_id = ? WHERE team_id = ?",
      [name, max.value, captainId, teamId]
    );
    res.json({ message: "Team updated" });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "ER_DUP_ENTRY") {
      res.status(409).json({ message: "A team with this name already exists in this activity." });
    } else {
      console.error(err);
      res.status(500).json({ message: "Database error" });
    }
  }
}

export async function deleteTeam(req: AuthedRequest, res: Response): Promise<void> {
  const teamId = parseInt(String(req.params.teamId), 10);
  if (!teamId) {
    res.status(400).json({ message: "Invalid team id." });
    return;
  }
  try {
    // Members go back to "no team"; their registrations stay
    await pool.query("UPDATE activity_registrations SET team_id = NULL WHERE team_id = ?", [teamId]);
    const [r] = await pool.query<ResultSetHeader>("DELETE FROM activity_teams WHERE team_id = ?", [teamId]);
    if (!r.affectedRows) {
      res.status(404).json({ message: "Team not found." });
      return;
    }
    res.json({ message: "Team deleted. Its members are now without a team." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export async function assignToTeam(req: AuthedRequest, res: Response): Promise<void> {
  const id = parseInt(String(req.params.id), 10);
  const employeeId = parseInt(String(req.params.employeeId), 10);
  const teamRaw = req.body?.teamId;
  const teamId = teamRaw === null || teamRaw === undefined || teamRaw === "" ? null : parseInt(String(teamRaw), 10);

  if (!id || !employeeId || (teamId !== null && !teamId)) {
    res.status(400).json({ message: "Invalid activity, employee or team." });
    return;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [reg] = await conn.query<RowDataPacket[]>(
      `SELECT registration_id, team_id FROM activity_registrations
       WHERE activity_id = ? AND employee_id = ? AND status = 'Registered' FOR UPDATE`,
      [id, employeeId]
    );
    if (!reg[0]) {
      await conn.rollback();
      res.status(404).json({ message: "That person is not registered for this activity." });
      return;
    }

    if (teamId !== null) {
      // The team must belong to this activity, and have room
      const [team] = await conn.query<RowDataPacket[]>(
        "SELECT max_members FROM activity_teams WHERE team_id = ? AND activity_id = ? FOR UPDATE",
        [teamId, id]
      );
      if (!team[0]) {
        await conn.rollback();
        res.status(404).json({ message: "That team does not belong to this activity." });
        return;
      }
      if (reg[0].team_id !== teamId && team[0].max_members !== null) {
        const [cnt] = await conn.query<RowDataPacket[]>(
          "SELECT COUNT(*) AS n FROM activity_registrations WHERE team_id = ? AND status = 'Registered'",
          [teamId]
        );
        if (Number(cnt[0].n) >= Number(team[0].max_members)) {
          await conn.rollback();
          res.status(400).json({ message: "This team is full." });
          return;
        }
      }
    }

    // Moving someone out of a team also removes them as its captain
    if (reg[0].team_id && reg[0].team_id !== teamId) {
      await conn.query(
        "UPDATE activity_teams SET captain_id = NULL WHERE team_id = ? AND captain_id = ?",
        [reg[0].team_id, employeeId]
      );
    }
    await conn.query("UPDATE activity_registrations SET team_id = ? WHERE registration_id = ?", [
      teamId,
      reg[0].registration_id,
    ]);

    await conn.commit();
    res.json({ message: teamId === null ? "Removed from the team." : "Added to the team." });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: "Database error" });
  } finally {
    conn.release();
  }
}