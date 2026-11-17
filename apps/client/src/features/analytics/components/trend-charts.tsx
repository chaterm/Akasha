import { ReactNode } from "react";
import { Paper, SimpleGrid, Text } from "@mantine/core";
import { BarChart, LineChart } from "@mantine/charts";
import { useTranslation } from "react-i18next";
import { IAnalyticsDailyRow } from "../types/analytics.types";

interface TrendChartsProps {
  daily: IAnalyticsDailyRow[];
  isWorkspace: boolean;
}

function ChartCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <Paper withBorder radius="md" p="md">
      <Text fw={600} size="sm" mb="md">
        {title}
      </Text>
      {children}
    </Paper>
  );
}

export function TrendCharts({ daily, isWorkspace }: TrendChartsProps) {
  const { t } = useTranslation();
  const data = daily.map((row) => ({ ...row, day: row.date.slice(5) }));
  const common = { h: 240, data, dataKey: "day", withLegend: true } as const;

  return (
    <SimpleGrid cols={{ base: 1, md: 2 }}>
      <ChartCard title={t("Page views and unique visitors")}>
        <LineChart
          {...common}
          curveType="monotone"
          withDots={false}
          series={[
            { name: "pv", label: "PV", color: "blue.6" },
            { name: "uv", label: "UV", color: "teal.6" },
          ]}
        />
      </ChartCard>

      <ChartCard title={t("Active users")}>
        <LineChart
          {...common}
          curveType="monotone"
          withDots={false}
          series={[
            { name: "uv", label: t("DAU"), color: "blue.6" },
            { name: "wau", label: t("WAU"), color: "teal.6" },
            { name: "mau", label: t("MAU"), color: "violet.6" },
          ]}
        />
      </ChartCard>

      <ChartCard title={t("Stickiness (DAU / MAU)")}>
        <LineChart
          {...common}
          data={data.map((row) => ({
            ...row,
            stickiness:
              row.mau > 0 ? Math.round((row.uv / row.mau) * 1000) / 10 : 0,
          }))}
          curveType="monotone"
          withDots={false}
          unit="%"
          series={[
            { name: "stickiness", label: t("Stickiness"), color: "orange.6" },
          ]}
        />
      </ChartCard>

      {isWorkspace && (
        <ChartCard title={t("Total users and public spaces")}>
          <LineChart
            {...common}
            curveType="monotone"
            withDots={false}
            withRightYAxis
            yAxisProps={{ domain: ["dataMin - 10", "dataMax + 10"] }}
            rightYAxisProps={{ domain: ["dataMin - 10", "dataMax + 10"] }}
            series={[
              { name: "userCount", label: t("Users"), color: "violet.6" },
              {
                name: "spaceCount",
                label: t("Public spaces"),
                color: "orange.6",
                yAxisId: "right",
              },
            ]}
          />
        </ChartCard>
      )}

      <ChartCard title={t("Content activity")}>
        <BarChart
          {...common}
          series={[
            { name: "newPages", label: t("New pages"), color: "blue.5" },
            { name: "pageEdits", label: t("Page edits"), color: "cyan.4" },
          ]}
        />
      </ChartCard>

      {isWorkspace && (
        <ChartCard title={t("New users, public spaces and AI questions")}>
          <BarChart
            {...common}
            series={[
              { name: "newUsers", label: t("New users"), color: "violet.5" },
              {
                name: "newSpaces",
                label: t("New public spaces"),
                color: "orange.5",
              },
              {
                name: "aiQuestions",
                label: t("AI questions"),
                color: "grape.5",
              },
            ]}
          />
        </ChartCard>
      )}
    </SimpleGrid>
  );
}
