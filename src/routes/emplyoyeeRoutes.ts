import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth";
import { listEmployees, createEmployee, getMyProfile,
     getEmployee, updateEmployee, 
     changeEmployeeStatus } from "../controllers/employeeController";
const router = Router();

router.use(requireAuth);
router.get("/", requireRole("HR", "Chief", "Manager"), listEmployees);
router.post("/", requireRole("HR"), createEmployee);
router.get("/me", getMyProfile);
router.get("/:id", getEmployee);
router.put("/:id", requireRole("HR"), updateEmployee);
router.patch("/:id/status", requireRole("HR"), changeEmployeeStatus);
export default router;