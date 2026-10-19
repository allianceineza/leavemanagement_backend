import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  listVacancies,
  getVacancy,
  createVacancy,
  updateVacancy,
  changeVacancyStatus,
  listApplications,
  getApplication,
  createApplication,
  changeApplicationStatus,
  listInterviews,
  scheduleInterview,
  recordInterviewResult,
  exportApplicationsPdf,
  hireApplicant,
} from "../controllers/recruitmentController";

const router = Router();

router.use(requireAuth);

// Vacancies
router.get("/vacancies", requireRole("HR", "Chief", "Manager"), listVacancies);
router.post("/vacancies", requireRole("HR"), createVacancy);
router.get("/vacancies/:id", requireRole("HR", "Chief", "Manager"), getVacancy);
router.put("/vacancies/:id", requireRole("HR"), updateVacancy);
router.patch("/vacancies/:id/status", requireRole("HR"), changeVacancyStatus);
router.get("/vacancies/:id/export", requireRole("HR"), exportApplicationsPdf);

// Applications for a vacancy
router.get("/vacancies/:id/applications", requireRole("HR", "Chief", "Manager"), listApplications);
router.post("/vacancies/:id/applications", requireRole("HR"), createApplication);

// One application
router.get("/applications/:id", requireRole("HR", "Chief", "Manager"), getApplication);
router.patch("/applications/:id/status", requireRole("HR"), changeApplicationStatus);
router.post("/applications/:id/hire", requireRole("HR"), hireApplicant);

// Interviews
router.get("/applications/:id/interviews", requireRole("HR", "Chief", "Manager"), listInterviews);
router.post("/applications/:id/interviews", requireRole("HR"), scheduleInterview);
router.patch("/interviews/:id/result", requireRole("HR"), recordInterviewResult);

export default router;