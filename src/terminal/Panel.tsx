import React from "react";
import { Box, Text } from "ink";

export function Panel({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold color="yellow">{title}</Text>
      {children}
    </Box>
  );
}

export function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Box>
      <Box width={14}><Text dimColor>{label}</Text></Box>
      <Text wrap="truncate-end">{children}</Text>
    </Box>
  );
}

export function Unavailable({ reason }: { reason: string }): React.JSX.Element {
  return <Text dimColor>unavailable: {reason}</Text>;
}
