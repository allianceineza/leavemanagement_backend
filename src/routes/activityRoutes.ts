import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  listActivities,
  getActivity,
  createActivity,
  updateActivity,
  changeActivityStatus,
  deleteActivity,
  registerMyself,
  registerSomeone,
  cancelRegistration,
  removeParticipant,
  listParticipants,
  listMyActivities,
  listTeams,
  createTeam,
  updateTeam,
  deleteTeam,
  assignToTeam,
} from "../controllers/activityController";

const router = Router();

router.use(requireAuth);
const hr = requireRole("HR");
const staff = requireRole("HR", "Chief", "Manager");

// Anyone logged in
router.get("/my", listMyActivities);
router.get("/", listActivities);

// HR creates
router.post("/", hr, createActivity);

// One activity
router.get("/:id", getActivity);
router.put("/:id", hr, updateActivity);
router.patch("/:id/status", hr, changeActivityStatus);
router.delete("/:id", hr, deleteActivity);

// Registration
router.post("/:id/register", registerMyself);
router.delete("/:id/register", cancelRegistration);
router.post("/:id/participants", hr, registerSomeone);
router.delete("/:id/participants/:employeeId", hr, removeParticipant);
router.get("/:id/participants", staff, listParticipants);

// Teams
router.get("/:id/teams", listTeams);
router.post("/:id/teams", hr, createTeam);
router.put("/:id/teams/:teamId", hr, updateTeam);
router.delete("/:id/teams/:teamId", hr, deleteTeam);
router.patch("/:id/participants/:employeeId/team", hr, assignToTeam);

export default router;