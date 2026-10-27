import "dotenv/config";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import cors from "cors";
import authRoutes from "./routes/authRoutes";
import departmentRoutes from "./routes/departmentRoutes";
import leaveRoutes from "./routes/leaveRoutes";
import manageRoutes from "./routes/manageRoutes";
import employeeRoutes from "./routes/employeeRoutes";
import recruitmentRoutes from "./routes/recruitmentRoutes";
import payrollRoutes from "./routes/payrollRoutes";
import settingsRoutes from "./routes/settingsRoutes";
import awardRoutes from "./routes/awardRoutes";
import activityRoutes from "./routes/activityRoutes";
import wellnessRoutes from "./routes/wellnessRoutes";

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is missing in the .env file");
}

const app = express();
app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api/departments", departmentRoutes);
app.use("/api/leave", leaveRoutes);
app.use("/api/manage", manageRoutes);
app.use("/api/employees", employeeRoutes);
app.use("/api/recruitment", recruitmentRoutes);
app.use("/api/payroll", payrollRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/awards", awardRoutes);
app.use("/api/wellness", wellnessRoutes);
app.use("/api/activities", activityRoutes);
// Any unexpected error returns a clear message instead of an empty page
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ message: "Unexpected server error. Please try again." });
});

const port = Number(process.env.PORT) || 5000;
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
