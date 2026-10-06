import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  getLeaveTypes,
  getMyBalances,
  getMyRequests,
  createRequest,
  cancelRequest,
  getPending,
  decideRequest,
  getNotifications,
  markNotificationsRead,
  getMyDecisions,
  getHrOnLeave,
} from "../controllers/leaveControllers";

const router = Router();

router.use(requireAuth);

router.get("/types", getLeaveTypes);
router.get("/balances", getMyBalances);
router.get("/my-requests", getMyRequests);
router.post("/requests", createRequest);
router.post("/requests/:id/cancel", cancelRequest);
router.get("/notifications", getNotifications);
router.post("/notifications/read", markNotificationsRead);
router.get("/pending", requireRole("Manager", "HR", "Chief"), getPending);
router.post("/requests/:id/decision", requireRole("Manager", "HR", "Chief"), decideRequest);
router.get("/decisions", requireRole("Manager", "HR", "Chief"), getMyDecisions);
router.get("/hr-on-leave", requireRole("Chief"), getHrOnLeave);

export default router;