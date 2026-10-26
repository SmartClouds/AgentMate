using Tapper;

namespace Runova.ServerCore.Contracts;

// Direct TLS (E16): an opt-in HTTPS port for servers the app cannot reach over SSH. Off by
// default. The core presents a self-signed certificate made when it was installed; the app pins its
// public key, read over SSH. Every device signs in with a client certificate for its enrolled
// device key, and the usual sign-in, sessions and roles apply on top.

/// <summary>
/// The direct TLS listener as the core runs it. Pin is the base64 SHA-256 of the certificate's
/// SubjectPublicKeyInfo. Sources is empty when any address may connect. Listening says whether
/// the port is bound right now; Error says why not when it should be.
/// </summary>
[TranspilationSource]
public sealed record DirectTlsStatus(
    bool Enabled,
    int Port,
    string[] Sources,
    bool Listening,
    string Pin,
    long CertificateNotAfterUnixMs,
    int DefaultPort,
    long? ChangedAtUnixMs = null,
    string? ChangedBy = null,
    string? Error = null);

/// <summary>Turns the listener on (Owner, with a step-up). Sources are addresses or CIDR networks.</summary>
[TranspilationSource]
public sealed record DirectTlsRequest(int Port, string[]? Sources = null);
