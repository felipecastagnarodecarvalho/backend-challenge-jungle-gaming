/** Flipped at the very start of graceful shutdown so `/health/ready` reports 503 and load balancers drain. */
export class ReadinessState {
  shuttingDown = false;
}
