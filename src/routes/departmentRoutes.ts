import { Router } from "express";
import type { RowDataPacket } from "mysql2";
import { pool } from "../db";

const router = Router();

// Public: the registration page needs the list before anyone is logged in
router.get("/", async (_req, res) => {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT department_id, department_name FROM departments ORDER BY department_name"
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Database error" });
  }
});

export default router;