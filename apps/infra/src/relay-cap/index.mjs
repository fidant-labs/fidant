import {
  GetInstanceMetricDataCommand,
  LightsailClient,
  PutInstancePublicPortsCommand,
} from "@aws-sdk/client-lightsail";
import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { configFromEnv, runCap } from "./cap.ts";

const lightsail = new LightsailClient({});
const ssm = new SSMClient({});
const parameter = "/fidant/relay-cap";

async function metricSum(instanceName, metricName, startTime, endTime) {
  const { metricData = [] } = await lightsail.send(
    new GetInstanceMetricDataCommand({
      instanceName,
      metricName,
      period: 3600,
      statistics: ["Sum"],
      unit: "Bytes",
      startTime,
      endTime,
    }),
  );
  return metricData.reduce((sum, point) => sum + (point.sum ?? 0), 0);
}

const deps = {
  async boxBytes(box, start, end) {
    const [received, sent] = await Promise.all([
      metricSum(box, "NetworkIn", start, end),
      metricSum(box, "NetworkOut", start, end),
    ]);
    return received + sent;
  },
  async readState() {
    try {
      const { Parameter } = await ssm.send(new GetParameterCommand({ Name: parameter }));
      return Parameter?.Value;
    } catch (error) {
      if (error?.name === "ParameterNotFound") {
        return undefined;
      }
      throw error;
    }
  },
  async writeState(json) {
    await ssm.send(
      new PutParameterCommand({ Name: parameter, Value: json, Type: "String", Overwrite: true }),
    );
  },
  async putPorts(box, ports) {
    await lightsail.send(
      new PutInstancePublicPortsCommand({ instanceName: box, portInfos: ports }),
    );
  },
  log: console.log,
};

export async function handler() {
  await runCap(deps, configFromEnv(process.env), new Date());
}
