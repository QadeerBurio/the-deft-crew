// utils/userRole.js
// An account's role as the app sees it. The User schema defaults role to "student", but that default
// only applies to documents Mongoose creates or hydrates: older accounts saved before the field existed
// have no `role` in the database, and a `.lean()` read returns it as undefined. The auth middleware
// already treats a missing role as "student" (req.userRole); every role read that decides what a
// student may see must do the same, or those students lose every student feature.
//
//   roleOf(user)          "student" | "brand" | "admin" | ... | null (no user)
//   NON_STUDENT_QUERY     accounts with an explicit role other than student (a missing role is a student)

const roleOf = (user) => (user ? user.role || "student" : null);

const NON_STUDENT_QUERY = { role: { $exists: true, $nin: ["student", null, ""] } };

module.exports = { roleOf, NON_STUDENT_QUERY };
