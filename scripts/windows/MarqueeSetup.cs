// MarqueeSetup.exe: opens the Marquee setup wizard (scripts\windows\setup-wizard.ps1) in its own
// window, with no console. Inside a Marquee folder it runs that installation's wizard; anywhere
// else (e.g. Downloads) it runs the wizard and install.ps1 embedded in it, which download, verify
// and install the release this file was built for.
//
// Built with the C# compiler that ships with Windows (.NET Framework 4): see build-setup-exe.ps1.
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

[assembly: AssemblyTitle("Marquee Setup")]
[assembly: AssemblyProduct("Marquee")]
[assembly: AssemblyDescription("Installs and sets up Marquee, the self-hosted media server")]
[assembly: AssemblyVersion("__ASSEMBLY_VERSION__")]
[assembly: AssemblyInformationalVersion("__VERSION__")]

static class MarqueeSetup {
  const string Version = "__VERSION__";

  static string Quote(string s) { return "\"" + s.Replace("\"", "\\\"") + "\""; }

  static string Extract(string name, string dir) {
    string path = Path.Combine(dir, name);
    using (Stream src = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
    using (FileStream dst = File.Create(path)) { src.CopyTo(dst); }
    return path;
  }

  [STAThread]
  static int Main() {
    string self = Assembly.GetExecutingAssembly().Location;
    string dir = Path.GetDirectoryName(self);
    string own = Path.Combine(dir, "scripts\\windows\\setup-wizard.ps1");
    string tmp = null;
    string args;
    try {
      if (File.Exists(own) && File.Exists(Path.Combine(dir, "setup.js"))) {
        args = "-File " + Quote(own);
      } else {
        tmp = Path.Combine(Path.GetTempPath(), "MarqueeSetup-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tmp);
        string wizard = Extract("setup-wizard.ps1", tmp);
        string install = Extract("install.ps1", tmp);
        args = "-File " + Quote(wizard) + " -InstallScript " + Quote(install) + " -Version " + Quote(Version);
      }
      ProcessStartInfo psi = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "WindowsPowerShell\\v1.0\\powershell.exe"),
        "-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden " + args + " -LauncherPath " + Quote(self));
      psi.UseShellExecute = false;
      psi.CreateNoWindow = true;
      psi.RedirectStandardError = true;
      psi.RedirectStandardOutput = true;
      using (Process p = Process.Start(psi)) {
        p.OutputDataReceived += delegate { };
        p.BeginOutputReadLine();
        string err = p.StandardError.ReadToEnd();
        p.WaitForExit();
        if (p.ExitCode != 0 && err.Trim().Length > 0) {
          MessageBox.Show("Marquee Setup stopped:\n\n" + err.Trim(), "Marquee Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        return p.ExitCode;
      }
    } catch (Exception e) {
      MessageBox.Show("Marquee Setup couldn't start:\n\n" + e.Message, "Marquee Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
      return 1;
    } finally {
      if (tmp != null) { try { Directory.Delete(tmp, true); } catch { } }
    }
  }
}
