import { Stack, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import type { Construct } from "constructs";

export type CertsStackProps = StackProps & { certificates: [string, ...string[]][] };

export class CertsStack extends Stack {
  constructor(scope: Construct, id: string, props: CertsStackProps) {
    super(scope, id, props);

    for (const [domainName, ...others] of props.certificates) {
      new acm.Certificate(this, domainName, {
        domainName,
        // ACM refuses an empty list of alternative names.
        subjectAlternativeNames: others.length > 0 ? others : undefined,
        validation: acm.CertificateValidation.fromDns(),
      });
    }
  }
}
