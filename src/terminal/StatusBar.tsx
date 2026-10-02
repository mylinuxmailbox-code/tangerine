import React from "react";
import { Box, Text } from "ink";
import type { TangerineState } from "../core/Lifecycle.js";

const COLORS: Record<TangerineState, string> = { idle: "gray", initializing: "yellow", preparing: "yellow", starting: "yellow", running: "green", stopping: "yellow", cleaning: "yellow", failed: "red", stopped: "gray" };

function StatusBarImpl({ state, graphics, sandbox, hint }: { state: TangerineState; graphics: string; sandbox: string; hint: string }): React.JSX.Element {
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Text><Text dimColor>STATUS </Text><Text color={COLORS[state]}>{state.toUpperCase()}</Text><Text dimColor>  Graphics: {graphics} | Sandbox: {sandbox}</Text></Text>
      <Text dimColor>{hint}</Text>
    </Box>
  );
}
export const StatusBar = React.memo(StatusBarImpl);
