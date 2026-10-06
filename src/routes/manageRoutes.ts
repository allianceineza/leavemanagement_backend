import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  getSummary,
  getOnLeave,
  exportOnLeave,
  getRequests,
  exportRequests,
  getAnalytics,
  getEmployees,
  generateBalances,
} from "../controllers/manageController";
const router = Router();

router.use(requireAuth, requireRole("HR"));

router.get("/summary", getSummary);
router.get("/on-leave", getOnLeave);
router.get("/export/on-leave", exportOnLeave);
router.get("/requests", getRequests);
router.get("/export/requests", exportRequests);
router.get("/analytics", getAnalytics);
router.get("/employees", getEmployees);
router.post("/balances/generate", generateBalances);
router.post("/balances/generate", generateBalances);
export default router;