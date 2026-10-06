import "dotenv/config";
import express from "express";
import cors from "cors";
import authRoutes from "./routes/authRoutes";
import departmentRoutes from "./routes/departmentRoutes";
import leaveRoutes from "./routes/leaveRoutes";
import manageRoutes from "./routes/manageRoutes";

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

const port = Number(process.env.PORT) || 5000;
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});