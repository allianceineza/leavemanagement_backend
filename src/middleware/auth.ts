import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import type { RowDataPacket } from "mysql2";
import { pool } from "../db";

export type Role = "Employee" | "Manager" | "HR" | "Chief";

export interface AuthPayload {
  userId: number;
  role: Role;
}

export type AuthedRequest = Request & { user?: AuthPayload };

export async function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.headers.authorization;
  const token = header && header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ message: "Please log in." });
    return;
  }

  let payload: AuthPayload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET as string) as AuthPayload;
  } catch {
    res.status(401).json({ message: "Session expired. Please log in again." });
    return;
  }

  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT u.role, e.status
       FROM users u JOIN employees e ON e.employee_id = u.employee_id
       WHERE u.user_id = ?`,
      [payload.userId]
    );
    const row = rows[0];
    if (!row || row.status !== "Active") {
      res.status(401).json({ message: "This account is no longer active." });
      return;
    }
    req.user = { userId: payload.userId, role: row.role as Role };
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}

export function requireRole(...roles: Role[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ message: "You do not have permission to do this." });
      return;
    }
    next();
  };
}