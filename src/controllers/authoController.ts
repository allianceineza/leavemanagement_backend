import type { Request, Response } from "express";
import type { RowDataPacket, ResultSetHeader } from "mysql2";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { pool } from "../db";

const ALLOWED_ROLES = ["Employee", "Manager", "HR", "Chief"];

export async function register(req: Request, res: Response): Promise<void> {
  const { fullName, email, departmentId, hireDate, password, role, registrationCode } = req.body;

  if (!fullName || !email || !departmentId || !hireDate || !password) {
    res.status(400).json({ message: "All fields are required." });
    return;
  }
  if (String(password).length < 8) {
    res.status(400).json({ message: "Password must be at least 8 characters." });
    return;
  }

  const chosenRole: string = role || "Employee";
  if (!ALLOWED_ROLES.includes(chosenRole)) {
    res.status(400).json({ message: "Invalid role." });
    return;
  }

    // Manager, HR and Chief accounts need a secret code (Chief has its own)
if (chosenRole !== "Employee") {
  const required =
    chosenRole === "Chief" ? process.env.CHIEF_REGISTRATION_CODE : process.env.REGISTRATION_CODE;
    if (!required || registrationCode !== required) {
      
      res.status(403).json({ message: "Invalid registration code for this role." });
      return;
    }
  }

  const cleanEmail = String(email).trim().toLowerCase();

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [emp] = await conn.query<ResultSetHeader>(
      "INSERT INTO employees (full_name, email, department_id, hire_date) VALUES (?, ?, ?, ?)",
      [fullName, cleanEmail, departmentId, hireDate]
    );
    await conn.query(
      "UPDATE employees SET employee_code = CONCAT('EMP-', LPAD(?, 4, '0')) WHERE employee_id = ?",
      [emp.insertId, emp.insertId]
    );
    const hash = await bcrypt.hash(String(password), 10);

    await conn.query(
      "INSERT INTO users (employee_id, full_name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)",
      [emp.insertId, fullName, cleanEmail, hash, chosenRole]
    );

    // Give the new person their leave balances for the current year
    await conn.query(
      `INSERT INTO leave_balances (employee_id, leave_type_id, year, days_allocated, days_used)
       SELECT ?, leave_type_id, YEAR(CURDATE()), days_allowed_per_year, 0 FROM leave_types`,
      [emp.insertId]
    );

    await conn.commit();
    res.status(201).json({ message: "Account created" });
  } catch (err) {
    await conn.rollback();
    const e = err as { code?: string };
    if (e.code === "ER_DUP_ENTRY") {
      res.status(409).json({ message: "That email is already registered." });
    } else if (e.code === "ER_NO_REFERENCED_ROW_2") {
      res.status(400).json({ message: "Invalid department." });
    } else {
      console.error(err);
      res.status(500).json({ message: "Database error" });
    }
  } finally {
    conn.release();
  }
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ message: "Email and password are required." });
    return;
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    res.status(500).json({ message: "Server is not configured." });
    return;
  }

  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT u.user_id, u.password_hash, u.role, e.full_name, e.status
       FROM users u JOIN employees e ON e.employee_id = u.employee_id
       WHERE e.email = ?`,
      [String(email).trim().toLowerCase()]
    );

    const user = rows[0];
    const ok = user && (await bcrypt.compare(String(password), user.password_hash));
    if (!ok) {
      res.status(401).json({ message: "Wrong email or password." });
      return;
    }

    if (user.status !== "Active") {
      res.status(403).json({ message: "This account is deactivated. Please contact HR." });
      return;
    }

    const token = jwt.sign({ userId: user.user_id, role: user.role }, secret, {
      expiresIn: "8h",
    });
    res.json({ token, role: user.role, fullName: user.full_name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}