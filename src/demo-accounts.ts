export const DEMO_PASSWORD = "DemoPass123!";

export const DEMO_ACCOUNTS = [
  {
    email: "patient@demo.local",
    name: "Alex Patient",
    role: "patient" as const,
  },
  {
    email: "patient2@demo.local",
    name: "Jamie Patient",
    role: "patient" as const,
  },
  {
    email: "patient3@demo.local",
    name: "Taylor Patient",
    role: "patient" as const,
  },
  {
    email: "patient4@demo.local",
    name: "Sam Patient",
    role: "patient" as const,
  },
  {
    email: "patient5@demo.local",
    name: "Priya Patient",
    role: "patient" as const,
  },
  {
    email: "doctor1@demo.local",
    name: "Dr. Morgan",
    role: "doctor" as const,
  },
  {
    email: "doctor2@demo.local",
    name: "Dr. Rivera",
    role: "doctor" as const,
  },
  {
    email: "doctor3@demo.local",
    name: "Dr. Chen",
    role: "doctor" as const,
  },
] as const;
