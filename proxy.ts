import { NextResponse, type NextRequest } from 'next/server';
import { authorized } from './lib/auth';

export function proxy(request: NextRequest) {
  // Connect deliveries use their own signed OIDC authentication, not operator auth.
  if (request.nextUrl.pathname === '/hooks') return NextResponse.next();
  try {
    if (authorized(request)) {
      const response = NextResponse.next();
      response.headers.set('Cache-Control', 'private, no-store');
      response.headers.set('Referrer-Policy', 'same-origin');
      response.headers.set('X-Content-Type-Options', 'nosniff');
      response.headers.set('X-Frame-Options', 'DENY');
      return response;
    }
    return new NextResponse('Sign in to the event demo.', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Fixture events", charset="UTF-8"' },
    });
  } catch {
    return new NextResponse('Operator authentication is not configured.', { status: 503 });
  }
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
