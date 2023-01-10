#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "@aws-cdk/core";
import { SonarqubeStack } from "../lib/sonarqube-stack";

const app = new cdk.App();
new SonarqubeStack(app, "SonarqubeStack", {
  env: {
    account: "109181328857",
    region: "us-west-2",
  },
  description: `SonarQube stack`,
});
