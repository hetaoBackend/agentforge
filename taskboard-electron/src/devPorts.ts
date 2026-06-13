export function lsofListeningPidsCommand(port: number): string {
  return `lsof -tiTCP:${port} -sTCP:LISTEN`;
}
