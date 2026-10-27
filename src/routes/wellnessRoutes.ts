import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  listFacilities,getFacility,createFacility,updateFacility,changeFacilityStatus,listAgreements,listExpiring,getAgreement, createAgreement,
  updateAgreement,activateAgreement,terminateAgreement,deleteAgreement,enrollMyself, enrollSomeone,listMembers,changeEnrollment,listMyMemberships,
  checkIn,recordVisitForMember,reviewVisit,listVisits,listMyVisits,listMyNotifications,markNotificationsRead,
} from "../controllers/facilityController";
import {
  listStatements,getStatement,createStatement,recalculateStatement,recordInvoice,approveStatement,markStatementPaid,deleteStatement,costReport,
} from "../controllers/statementController";

const router = Router();

router.use(requireAuth);
const hr = requireRole("HR");
const staff = requireRole("HR", "Chief");

// Everything about me comes first, so "my-..." is never read as an id
router.get("/my-memberships", listMyMemberships);
router.get("/my-visits", listMyVisits);
router.get("/my-notifications", listMyNotifications);
router.post("/my-notifications/read", markNotificationsRead);

// Facilities: everyone sees the available ones (practical details only), HR manages
router.get("/facilities", listFacilities);
router.post("/facilities", hr, createFacility);
router.get("/facilities/:id", getFacility);
router.put("/facilities/:id", hr, updateFacility);
router.patch("/facilities/:id/status", hr, changeFacilityStatus);

// Enrollment and visits
router.post("/facilities/:id/enroll", enrollMyself);
router.post("/facilities/:id/members", hr, enrollSomeone);
router.get("/facilities/:id/members", staff, listMembers);
router.patch("/enrollments/:enrollmentId", hr, changeEnrollment);
router.post("/facilities/:id/check-in", checkIn);
router.post("/facilities/:id/visits", hr, recordVisitForMember);
router.get("/visits", staff, listVisits);
router.patch("/visits/:visitId", hr, reviewVisit);

// Agreements: commercial terms, HR and Chief only
router.get("/agreements/expiring", staff, listExpiring);
router.get("/agreements", staff, listAgreements);
router.post("/agreements", hr, createAgreement);
router.get("/agreements/:id", staff, getAgreement);
router.put("/agreements/:id", hr, updateAgreement);
router.post("/agreements/:id/activate", hr, activateAgreement);
router.post("/agreements/:id/terminate", hr, terminateAgreement);
router.delete("/agreements/:id", hr, deleteAgreement);

// Monthly statements and the cost report
router.get("/statements", staff, listStatements);
router.post("/statements", hr, createStatement);
router.get("/statements/:id", staff, getStatement);
router.post("/statements/:id/recalculate", hr, recalculateStatement);
router.patch("/statements/:id/invoice", hr, recordInvoice);
router.post("/statements/:id/approve", hr, approveStatement);
router.post("/statements/:id/pay", hr, markStatementPaid);
router.delete("/statements/:id", hr, deleteStatement);
router.get("/reports/cost", staff, costReport);

export default router;