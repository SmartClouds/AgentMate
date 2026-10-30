using Runova.Website.Api;
using Runova.Website.Api.Cli;
using Runova.Website.Api.Database;
using Runova.Website.Api.Health;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Jobs;
using Runova.Website.Api.Json;
using Runova.Website.Api.Problems;
using Runova.Website.Api.Telemetry;
using Runova.Website.Api.Users;
using Runova.Website.Data;
using Scalar.AspNetCore;

// The admin verbs are not configuration, so they stay out of the builder's command line.
var builder = WebApplication.CreateBuilder(AdminCli.IsCommand(args) ? [] : args);

builder.AddWebsiteTelemetry();
builder.Services.AddWebsiteData();
builder.Services.AddWebsiteIdentity();
builder.Services.AddWebsiteUsers();
builder.Services.AddWebsiteJobs();
builder.Services.AddWebsiteJson();
builder.Services.AddHostedService<MigrateOnStart>();
builder.Services.AddWebsiteProblemDetails();
builder.Services.AddWebsiteHealthChecks();
builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer((document, _, _) =>
    {
        document.Info.Title = "Runova Website API";
        document.Info.Version = "v1";
        return Task.CompletedTask;
    });
    options.AddSchemaTransformer(JsonSetup.DescribeTimes);
});

var app = builder.Build();

if (AdminCli.IsCommand(args))
{
    return await AdminCli.RunAsync(args, app.Services, Console.In, Console.Out, Console.Error);
}

app.UseWebsiteProblemDetails();
app.UseWebsiteIdentity();

app.MapOpenApi().AllowAnonymous();
if (app.Environment.IsDevelopment() || app.Environment.IsStaging())
{
    app.MapScalarApiReference().AllowAnonymous();
}

app.MapHealth();
app.MapApiV1();
app.MapJobsDashboard();

await app.RunAsync();
return 0;
