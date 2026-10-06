import type { Request, Response } from "express";
import type { RowDataPacket } from "mysql2";
import { pool } from "../db";

export async function getDepartments(_req: Request, res: Response): Promise<void> {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT department_id, department_name FROM departments ORDER BY department_name"
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
}