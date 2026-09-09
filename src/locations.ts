export const DEFAULT_LOCATIONS = [
  { slug: "lagos", name: "Lagos", country: "Nigeria" },
  { slug: "abuja", name: "Abuja", country: "Nigeria" },
  { slug: "london", name: "London", country: "United Kingdom" },
  { slug: "new-york", name: "New York", country: "United States" },
  { slug: "dubai", name: "Dubai", country: "United Arab Emirates" },
] as const;

export type DefaultLocationSlug = (typeof DEFAULT_LOCATIONS)[number]["slug"];

export const DEMO_DOCTOR_LOCATIONS: Record<string, DefaultLocationSlug[]> = {
  "doctor1@demo.local": ["lagos", "abuja"],
  "doctor2@demo.local": ["london", "new-york"],
  "doctor3@demo.local": ["dubai"],
};
