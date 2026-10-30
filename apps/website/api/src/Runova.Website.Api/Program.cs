using Runova.Website.Api;
using Runova.Website.Api.Health;
using Runova.Website.Api.Problems;
using Runova.Website.Data;
using Scalar.AspNetCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddWebsiteData();
builder.Services.AddWebsiteProblemDetails();
builder.Services.AddWebsiteHealthChecks();
builder.Services.AddOpenApi(options => options.AddDocumentTransformer((document, _, _) =>
{
    document.Info.Title = "Runova Website API";
    document.Info.Version = "v1";
    return Task.CompletedTask;
}));

var app = builder.Build();

app.UseWebsiteProblemDetails();

app.MapOpenApi();
if (app.Environment.IsDevelopment() || app.Environment.IsStaging())
{
    app.MapScalarApiReference();
}

app.MapHealth();
app.MapApiV1();

app.Run();
