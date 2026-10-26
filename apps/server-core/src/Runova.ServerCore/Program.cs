using Runova.ServerCore;
using Runova.ServerCore.Cli;

return await CoreEntryPoint.RunAsync(args, Console.Out, Console.Error, ServeAsync);

static async Task<int> ServeAsync(string[] args)
{
    await using var app = CoreApplication.Build(args);
    await app.RunAsync();
    return 0;
}

/// <summary>The entry point type, public so the test factory can boot the real host.</summary>
public partial class Program;
