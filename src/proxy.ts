import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const allowedOrigins = [
  "http://localhost:3000",
  "https://medinexa-clinic.onrender.com",
  "https://healthcare.jido.co.in",
  "https://awake-up-git-main-sids-projects-85c8cf36.vercel.app/",
  "http://localhost:8081",
  "http://localhost:4200", // jido-healthcare-app: ng serve
  "http://localhost:8100", // jido-healthcare-app: ionic serve
  "http://localhost", // Capacitor Android WebView default origin
  "https://localhost", // Capacitor Android WebView default origin (androidScheme: 'https')
  "capacitor://localhost", // Capacitor iOS WebView default origin
];

const corsOptions = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Idempotency-Key",
};

export default function proxy(request: NextRequest) {
  const origin = request.headers.get("origin") ?? "";
  const isAllowedOrigin = allowedOrigins.includes(origin);

  if (request.method === "OPTIONS") {
    const preflightHeaders: Record<string, string> = {
      "Vary": "Origin",
      ...corsOptions,
    };
    if (isAllowedOrigin) {
      preflightHeaders["Access-Control-Allow-Origin"] = origin;
    }
    return NextResponse.json({}, { headers: preflightHeaders });
  }

  const response = NextResponse.next();
  response.headers.set("Vary", "Origin");

  if (isAllowedOrigin) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    Object.entries(corsOptions).forEach(([key, value]) => {
      response.headers.set(key, value);
    });
  }

  return response;
}

export const config = {
  matcher: "/api/:path*",
};
