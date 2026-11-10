// System default categories from the spec. M2+ seeds these via migration;
// the agent always receives the user's full list (defaults + custom).
export const DEFAULT_CATEGORIES = [
  { slug: "food-dining", name: "Food & Dining" },
  { slug: "groceries", name: "Groceries" },
  { slug: "transport", name: "Transport" },
  { slug: "travel", name: "Travel" },
  { slug: "utilities", name: "Utilities" },
  { slug: "housing", name: "Housing" },
  { slug: "shopping", name: "Shopping" },
  { slug: "health", name: "Health" },
  { slug: "entertainment", name: "Entertainment" },
  { slug: "education", name: "Education" },
  { slug: "subscriptions", name: "Subscriptions" },
  { slug: "business", name: "Business" },
  { slug: "other", name: "Other" },
] as const;

export const FALLBACK_CATEGORY = "other";
