import type { StudioAppInstance } from '../appFactory';
import { createHostedStudio } from './hostedStudio';

// Neon Function entry for hosted Cozy Studio (ADR 0013). The app is built once per instance; a
// failed start is retried on the next request instead of leaving the instance broken.
let studio: Promise<StudioAppInstance> | null = null;

export default {
  async fetch(request: Request) {
    studio ??= createHostedStudio().catch((error) => {
      studio = null;
      throw error;
    });
    try {
      return (await studio).app.fetch(request);
    } catch (error) {
      console.error('Hosted Cozy Studio failed to start:', error);
      return Response.json(
        { error: 'Cozy Studio is starting up. Try again shortly.' },
        { status: 503 },
      );
    }
  },
};
