import "express";

declare global {
  namespace Express {
    interface User {
      id: string;
      email: string;
      name: string;
      provider: "Google" | "Github" | "Local";
      providerAccountId: string;
      passwordHash?: string | null;
    }
  }
}

export {};
