namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>
/// Tests that read Sentry or OpenTelemetry output. Sentry keeps one hub for the whole process and
/// activity listeners hear every host, so these run alone, after the parallel tests.
/// </summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class TelemetryTestGroup
{
    public const string Name = "Telemetry";
}
