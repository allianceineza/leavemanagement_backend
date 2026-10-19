import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  listEmployees,
  createEmployee,
  getMyProfile,
  updateMyProfile,
  getEmployee,
  updateEmployee,
  changeEmployeeStatus,
  getEmployeeHistory,
  changeEmployeeRole,
  resetEmployeePassword,changeMyPassword,
} from "../controllers/employeeController";

const router = Router();

router.use(requireAuth);

router.get("/", requireRole("HR", "Chief", "Manager"), listEmployees);
router.post("/", requireRole("HR"), createEmployee);

// "/me" must come before "/:id", otherwise Express reads "me" as an id
router.get("/me", getMyProfile);
router.patch("/me", updateMyProfile);

router.get("/:id", getEmployee);
router.put("/:id", requireRole("HR"), updateEmployee);
router.patch("/:id/status", requireRole("HR"), changeEmployeeStatus);
router.get("/:id/history", requireRole("HR"), getEmployeeHistory);
router.patch("/:id/role", requireRole("HR"), changeEmployeeRole);
router.post("/:id/reset-password", requireRole("HR"), resetEmployeePassword);
router.patch("/me/password", changeMyPassword);

export default router;