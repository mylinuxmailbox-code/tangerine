import React from "react";
import { Box, Text } from "ink";
import { Panel } from "./Panel.js";

/** Shown by `tangerine benchmark`: progress lines supplied by the runner. */
function BenchmarkPanelImpl({ lines }: { lines: readonly string[] }): React.JSX.Element {
  return (
    <Panel title="BENCHMARK">
      {lines.slice(-6).map((l, i) => (
        <Box key={i}><Text>{l}</Text></Box>
      ))}
    </Panel>
  );
}
export const BenchmarkPanel = React.memo(BenchmarkPanelImpl);
