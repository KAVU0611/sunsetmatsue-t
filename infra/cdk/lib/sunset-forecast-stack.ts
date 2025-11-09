import * as path from "node:path";
import {
  CfnOutput,
  CustomResource,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  StackProps
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as s3 from "aws-cdk-lib/aws-s3";

export interface SunsetForecastStackProps extends StackProps {
  readonly myDomainName: string;
  readonly frontendOrigin?: string;
  readonly bedrockModelId?: string;
  readonly bedrockRegion?: string;
  readonly weatherApiKey?: string;
  readonly defaultLat?: string;
  readonly defaultLon?: string;
  readonly cdnHost?: string;
}

export class SunsetForecastStack extends Stack {
  private readonly corsPrimaryOrigin: string;

  constructor(scope: Construct, id: string, props: SunsetForecastStackProps) {
    super(scope, id, props);

    const apexDomain = props.myDomainName;
    const wwwDomain = `www.${props.myDomainName}`;
    const canonicalHttpsOrigins = [`https://${apexDomain}`, `https://${wwwDomain}`];
    const frontendOrigins =
      props.frontendOrigin
        ?.split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0) ?? [];
    const resolvedAllowedOrigins = Array.from(new Set([...canonicalHttpsOrigins, ...frontendOrigins]));
    this.corsPrimaryOrigin = canonicalHttpsOrigins[0];

    const hostedZone = new route53.HostedZone(this, "SunsetHostedZone", {
      zoneName: apexDomain,
      comment: "Hosted zone created by CDK. Final DNS records managed manually."
    });
    hostedZone.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const certificateRequestorFn = new lambda.Function(this, "SiteCertificateCertificateRequestorFunction", {
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.X86_64,
      handler: "lambda_function.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../../../services/lambda/site-certificate-requestor")),
      memorySize: 512,
      timeout: Duration.seconds(900),
      logRetention: logs.RetentionDays.ONE_WEEK,
      environment: {
        SKIP_WAIT: "0",
        ACM_REGION: "us-east-1",
        MAX_WAIT_SECONDS: "900"
      }
    });

    certificateRequestorFn.grantInvoke(new iam.ServicePrincipal("cloudformation.amazonaws.com"));
    certificateRequestorFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["route53:ChangeResourceRecordSets"],
        resources: [hostedZone.hostedZoneArn]
      })
    );
    certificateRequestorFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["route53:ListHostedZonesByName", "route53:ListResourceRecordSets"],
        resources: ["*"]
      })
    );
    certificateRequestorFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["acm:RequestCertificate", "acm:DescribeCertificate", "acm:ListCertificates", "acm:DeleteCertificate", "acm:AddTagsToCertificate"],
        resources: ["*"]
      })
    );
    certificateRequestorFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
        resources: ["*"]
      })
    );

    const siteCertificateCustomResource = new CustomResource(this, "SiteCertificateCertificateRequestorResource", {
      serviceToken: certificateRequestorFn.functionArn,
      properties: {
        DomainName: apexDomain,
        SubjectAlternativeNames: [wwwDomain],
        HostedZoneId: hostedZone.hostedZoneId,
        Region: "us-east-1",
        StackName: Stack.of(this).stackName
      }
    });
    const siteCertificateArn = siteCertificateCustomResource.getAttString("CertificateArn");

    const imageBucket = new s3.Bucket(this, "CardImagesBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false
    });

    const pillowLayer = new lambda.LayerVersion(this, "PillowLayer", {
      description: "Pillow runtime for generate-card",
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
      compatibleArchitectures: [lambda.Architecture.X86_64],
      code: lambda.Code.fromAsset(path.join(__dirname, "../../../layers/pillow"), {
        bundling: {
          image: lambda.Runtime.PYTHON_3_12.bundlingImage,
          command: [
            "bash",
            "-c",
            [
              "pip install pillow==10.4.0 -t /asset-output/python/lib/python3.12/site-packages",
              "find /asset-output -type f -name '*.pyc' -delete"
            ].join(" && ")
          ]
        }
      })
    });

    const generateCardFn = new lambda.Function(this, "GenerateCard", {
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.X86_64,
      handler: "lambda_function.lambda_handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../../../services/lambda/generate-card"), {
        bundling: {
          image: lambda.Runtime.PYTHON_3_12.bundlingImage,
          command: [
            "bash",
            "-c",
            [
              "if [ -f requirements.txt ]; then pip install -r requirements.txt -t /asset-output; fi",
              "cp -R . /asset-output"
            ].join(" && ")
          ]
        }
      }),
      timeout: Duration.seconds(30),
      memorySize: 2048,
      tracing: lambda.Tracing.ACTIVE,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        MODEL_ID: props.bedrockModelId ?? "amazon.titan-image-generator-v1",
        BEDROCK_REGION: props.bedrockRegion ?? "us-east-1",
        OUTPUT_BUCKET: imageBucket.bucketName,
        CODE_VERSION: "2025-11-07-02",
        CDN_HOST: props.cdnHost ?? `https://${apexDomain}`
      },
      layers: [pillowLayer]
    });

    imageBucket.grantReadWrite(generateCardFn);
    generateCardFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: ["*"]
      })
    );
    generateCardFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:GetParametersByPath",
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
          "kms:Decrypt"
        ],
        resources: ["*"]
      })
    );

    const sunsetIndexFn = new lambda.Function(this, "SunsetIndexFunction", {
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.X86_64,
      handler: "lambda_function.lambda_handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../../../services/lambda/sunset-score"), {
        bundling: {
          image: lambda.Runtime.PYTHON_3_12.bundlingImage,
          command: [
            "bash",
            "-c",
            [
              "if [ -f requirements.txt ]; then pip install -r requirements.txt -t /asset-output; fi",
              "cp -R . /asset-output"
            ].join(" && ")
          ]
        }
      }),
      timeout: Duration.seconds(20),
      memorySize: 512,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        OPENWEATHER_API: props.weatherApiKey ?? "",
        LAT: props.defaultLat ?? "35.468",
        LON: props.defaultLon ?? "133.050"
      }
    });

    const api = new apigateway.RestApi(this, "SunsetApi", {
      restApiName: "Sunset Forecast",
      deployOptions: {
        stageName: "prod",
        tracingEnabled: true,
        metricsEnabled: true,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: false,
        accessLogDestination: new apigateway.LogGroupLogDestination(
          new logs.LogGroup(this, "ApiAccessLogs", {
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: RemovalPolicy.DESTROY
          })
        ),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields()
      },
      defaultCorsPreflightOptions: {
        allowOrigins: resolvedAllowedOrigins,
        allowMethods: ["GET", "POST", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization"]
      }
    });

    const apiV1 = api.root.addResource("v1");
    const sunsetIndexResource = apiV1.addResource("sunset-index");
    sunsetIndexResource.addMethod("GET", new apigateway.LambdaIntegration(sunsetIndexFn));
    this.addCorsOptions(sunsetIndexResource);

    const generateCardResource = apiV1.addResource("generate-card");
    generateCardResource.addMethod("POST", new apigateway.LambdaIntegration(generateCardFn));
    this.addCorsOptions(generateCardResource);

    const forecastResource = apiV1.addResource("forecast").addResource("sunset");
    forecastResource.addMethod("GET", new apigateway.LambdaIntegration(generateCardFn));
    this.addCorsOptions(forecastResource);

    const oac = new cloudfront.CfnOriginAccessControl(this, "ImagesOAC", {
      originAccessControlConfig: {
        name: `${Stack.of(this).stackName}-images-oac`,
        originAccessControlOriginType: "s3",
        signingBehavior: "always",
        signingProtocol: "sigv4",
        description: "Origin access control for generated images"
      }
    });

    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, "ImagesResponseHeaders", {
      responseHeadersPolicyName: `${Stack.of(this).stackName}-images-rhp`,
      comment: "CORS headers for generated card images",
      corsBehavior: {
        accessControlAllowCredentials: false,
        accessControlAllowHeaders: ["*"],
        accessControlAllowMethods: ["GET", "HEAD", "OPTIONS"],
        accessControlAllowOrigins: [`https://${apexDomain}`, `https://${wwwDomain}`],
        originOverride: true
      }
    });

    const cachePolicyId = cloudfront.CachePolicy.CACHING_OPTIMIZED.cachePolicyId;
    const distribution = new cloudfront.CfnDistribution(this, "ImagesDistribution", {
      distributionConfig: {
        enabled: true,
        comment: "Sunset Forecast generated cards",
        priceClass: "PriceClass_100",
        origins: [
          {
            id: "ImagesS3Origin",
            domainName: imageBucket.bucketRegionalDomainName,
            s3OriginConfig: {},
            originAccessControlId: oac.attrId
          }
        ],
        defaultCacheBehavior: {
          targetOriginId: "ImagesS3Origin",
          viewerProtocolPolicy: "redirect-to-https",
          allowedMethods: ["GET", "HEAD", "OPTIONS"],
          cachedMethods: ["GET", "HEAD", "OPTIONS"],
          compress: true,
          cachePolicyId,
          responseHeadersPolicyId: responseHeadersPolicy.responseHeadersPolicyId
        },
        cacheBehaviors: [
          {
            pathPattern: "images/*",
            targetOriginId: "ImagesS3Origin",
            viewerProtocolPolicy: "redirect-to-https",
            allowedMethods: ["GET", "HEAD", "OPTIONS"],
            cachedMethods: ["GET", "HEAD", "OPTIONS"],
            compress: true,
            cachePolicyId,
            responseHeadersPolicyId: responseHeadersPolicy.responseHeadersPolicyId,
            minTtl: 0,
            defaultTtl: Duration.hours(1).toSeconds(),
            maxTtl: Duration.days(1).toSeconds()
          }
        ],
        aliases: [apexDomain, wwwDomain],
        viewerCertificate: {
          acmCertificateArn: siteCertificateArn,
          sslSupportMethod: "sni-only",
          minimumProtocolVersion: "TLSv1.2_2021"
        },
        restrictions: {
          geoRestriction: {
            restrictionType: "none"
          }
        }
      }
    });

    imageBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AllowCloudFrontPrivateAccess",
        actions: ["s3:GetObject"],
        principals: [new iam.ServicePrincipal("cloudfront.amazonaws.com")],
        resources: [imageBucket.arnForObjects("*")],
        conditions: {
          StringEquals: {
            "AWS:SourceArn": `arn:aws:cloudfront::${Stack.of(this).account}:distribution/${distribution.attrId}`
          }
        }
      })
    );

    generateCardFn.addEnvironment("CLOUDFRONT_DOMAIN", distribution.attrDomainName);

    const cloudFrontAliasTarget: route53.IAliasRecordTarget = {
      bind: (): route53.AliasRecordTargetConfig => ({
        hostedZoneId: "Z2FDTNDATAQYW2",
        dnsName: distribution.attrDomainName
      })
    };

    new route53.ARecord(this, "ApexAliasRecord", {
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(cloudFrontAliasTarget)
    });

    new route53.AaaaRecord(this, "ApexAliasRecordIpv6", {
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(cloudFrontAliasTarget)
    });

    new route53.CnameRecord(this, "WwwCnameRecord", {
      zone: hostedZone,
      recordName: "www",
      domainName: apexDomain
    });

    new CfnOutput(this, "ApiUrl", { value: `${api.url}v1` });
    new CfnOutput(this, "ImagesBucketName", { value: imageBucket.bucketName });
    new CfnOutput(this, "CloudFrontDomain", { value: distribution.attrDomainName });
    new CfnOutput(this, "CloudFrontDistributionId", { value: distribution.attrId });
    new CfnOutput(this, "HostedZoneId", { value: hostedZone.hostedZoneId });
    new CfnOutput(this, "HostedZoneNameServers", {
      value: hostedZone.hostedZoneNameServers
        ? Fn.join(",", hostedZone.hostedZoneNameServers)
        : "pending"
    });
    new CfnOutput(this, "DnsRecordGuidance", {
      value: `A/AAAA aliases for ${props.myDomainName} and www CNAME are managed by CDK. Ensure registrar NS = ${props.myDomainName} HostedZoneNameServers.`
    });
  }

  private addCorsOptions(resource: apigateway.IResource): void {
    if (resource.node.tryFindChild("OPTIONS")) {
      return;
    }
    resource.addMethod(
      "OPTIONS",
      new apigateway.MockIntegration({
        integrationResponses: [
          {
            statusCode: "200",
            responseParameters: {
              "method.response.header.Access-Control-Allow-Origin": `'${this.corsPrimaryOrigin}'`,
              "method.response.header.Access-Control-Allow-Credentials": "'false'",
              "method.response.header.Access-Control-Allow-Headers": "'Content-Type,Authorization'",
              "method.response.header.Access-Control-Allow-Methods": "'GET,POST,OPTIONS'"
            }
          }
        ],
        passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
        requestTemplates: {
          "application/json": '{"statusCode": 200}'
        }
      }),
      {
        methodResponses: [
          {
            statusCode: "200",
            responseParameters: {
              "method.response.header.Access-Control-Allow-Origin": true,
              "method.response.header.Access-Control-Allow-Credentials": true,
              "method.response.header.Access-Control-Allow-Headers": true,
              "method.response.header.Access-Control-Allow-Methods": true
            }
          }
        ]
      }
    );
  }
}
