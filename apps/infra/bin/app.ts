import { App } from "aws-cdk-lib";
import { addStacks } from "../src/app.ts";

addStacks(new App(), process.env);
