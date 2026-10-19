import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  listLeaveTypes,
  createLeaveType,
  updateLeaveType,
  deleteLeaveType,
  listDepartments,
  createDepartment,
  renameDepartment,
  deleteDepartment,
  listChanges,
} from "../controllers/settingsController";

const router = Router();

router.use(requireAuth, requireRole("HR"));

router.get("/leave-types", listLeaveTypes);
router.post("/leave-types", createLeaveType);
router.patch("/leave-types/:id", updateLeaveType);
router.delete("/leave-types/:id", deleteLeaveType);

router.get("/departments", listDepartments);
router.post("/departments", createDepartment);
router.patch("/departments/:id", renameDepartment);
router.delete("/departments/:id", deleteDepartment);

router.get("/changes", listChanges);

export default router;