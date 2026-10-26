using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Docker;

/// <summary>
/// Problems the DevHost shows on purpose (E09): a "newsletter" project whose sender keeps
/// crashing, so the problems feed and the Deploy AI have something to diagnose. Never part of the
/// seed the tests count on.
/// </summary>
internal sealed partial class InMemoryDockerEngine
{
    public const string CrashLoopContainer = "newsletter-sender-1";

    public InMemoryDockerEngine WithCrashLoop()
    {
        lock (_gate)
        {
            var sender = new Container(CrashLoopContainer, "shop-api:latest", "newsletter", "sender", Kind.Crashing)
            {
                Environment = [new("SMTP_URL", $"smtp://mailer:{ApiToken}@smtp.internal:587")],
                Command = ["node", "sender.js"],
                Load = 0.01,
                MemoryBase = 40L * 1024 * 1024,
            };
            Add(sender);
            sender.State = ContainerState.Restarting;
            sender.RestartCount = 37;
        }

        return this;
    }

    /// <summary>
    /// The container exits on its own and Docker's restart policy starts it again at once: the events
    /// one round of a crash loop gives (E30).
    /// </summary>
    public void SimulateCrash(string container, int exitCode = 1)
    {
        lock (_gate)
        {
            var found = Find(container);
            found.Exit(NowMs, exitCode);
            Raise("container", "die", found, ("exitCode", exitCode.ToString(System.Globalization.CultureInfo.InvariantCulture)));
            found.Start(NowMs);
            found.RestartCount++;
            Raise("container", "start", found);
        }
    }

    /// <summary>How many event streams are open right now.</summary>
    public int EventListeners
    {
        get
        {
            lock (_gate)
            {
                return _listeners.Count;
            }
        }
    }
}
