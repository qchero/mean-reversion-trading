import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  providers: [Google],
  callbacks: {
    signIn({ profile }) {
      const allowed = process.env.ALLOWED_EMAIL;
      if (!allowed) return false;
      return profile?.email === allowed;
    },
  },
});
