# Lilin setup wizard for Windows: a normal Windows window that installs Lilin, sets it up and
# can add Clipper (game clips). Start it with LilinSetup.exe, the "Lilin Setup" Start menu
# entry, `node setup.js gui`, or:
#   powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File scripts\windows\setup-wizard.ps1
#
# It does no setup of its own. Every change goes through the same commands the terminal uses:
#   install.ps1 -NoSetup                  download, checksum-check and unpack a release
#   node setup.js wizard info|check|clipper   read the current state as JSON (changes nothing)
#   node setup.js --config FILE           write .env (the answers file is deleted straight after)
#   node setup.js user add EMAIL          the owner's sign-in (password passed in LILIN_PASSWORD)
#   node setup.js clipper --config FILE   game clips folder, and Clipper itself on this PC
#   install-service.ps1 (elevated)        start at boot; your Windows password goes over in a file
#                                         only your account can decrypt (DPAPI), deleted when read
# Nothing runs as administrator except that last step, after a Windows (UAC) prompt.
param(
  [string]$AppDir = '',          # set up this installation (default: the one this script is part of)
  [string]$Version = '',         # new installs: release to download (default: the latest)
  [string]$InstallScript = '',   # new installs: install.ps1 to use (LilinSetup.exe passes its own copy)
  [string]$BundledVersion = '',  # the release $InstallScript came from; used if the latest can't be looked up
  [string]$LauncherPath = '',    # the LilinSetup.exe that started this; copied into the installation
  [string]$Screenshot = '',      # testing: render every page to PNG files in this folder, then exit
  [switch]$SelfTest,             # testing: build the window and check it, then exit
  [string]$TestRun = ''          # testing: JSON file of page values; runs the whole plan hidden (no admin step), prints the log
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Net.Http

$Native = @'
using System;
using System.Runtime.InteropServices;
public static class LilinNative {
  [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int value, int size);
  public static void DarkTitle(IntPtr h, int captionBgr) {
    int on = 1; DwmSetWindowAttribute(h, 20, ref on, 4);          // immersive dark mode
    DwmSetWindowAttribute(h, 35, ref captionBgr, 4);              // caption colour (Windows 11)
  }
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogRCW { }
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint c, IntPtr f); void SetFileTypeIndex(uint i); void GetFileTypeIndex(out uint i);
    void Advise(IntPtr e, out uint c); void Unadvise(uint c);
    void SetOptions(uint o); void GetOptions(out uint o);
    void SetDefaultFolder(IShellItem i); void SetFolder(IShellItem i); void GetFolder(out IShellItem i);
    void GetCurrentSelection(out IShellItem i); void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string n);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string n); void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string t);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string t); void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
    void GetResult(out IShellItem i);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr p, ref Guid b, ref Guid r, out IntPtr v); void GetParent(out IShellItem i);
    void GetDisplayName(uint t, [MarshalAs(UnmanagedType.LPWStr)] out string n);
    void GetAttributes(uint m, out uint a); void Compare(IShellItem i, uint h, out int o);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr ctx, ref Guid riid, out IShellItem item);
  // The modern folder picker (the one Explorer uses), or null if cancelled.
  public static string PickFolder(IntPtr owner, string title, string start) {
    IFileDialog d = (IFileDialog)new FileOpenDialogRCW();
    d.SetOptions(0x20 | 0x40 | 0x800);                            // pick folders, file system only, must exist
    d.SetTitle(title);
    try {
      if (!String.IsNullOrEmpty(start) && System.IO.Directory.Exists(start)) {
        Guid g = typeof(IShellItem).GUID; IShellItem i; SHCreateItemFromParsingName(start, IntPtr.Zero, ref g, out i); d.SetFolder(i);
      }
    } catch { }
    if (d.Show(owner) != 0) return null;
    IShellItem r; d.GetResult(out r); string p; r.GetDisplayName(0x80058000, out p); return p;
  }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool LogonUser(string user, string domain, string pass, int type, int provider, out IntPtr token);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  // 1 = accepted, 0 = refused, -1 = couldn't tell (e.g. no batch logon right yet). Batch logon is
  // what Task Scheduler uses for "run whether signed in or not".
  public static int CheckPassword(string user, string domain, string pass) {
    IntPtr t;
    if (LogonUser(user, domain, pass, 4, 0, out t)) { CloseHandle(t); return 1; }
    int e = Marshal.GetLastWin32Error();
    return e == 1326 ? 0 : -1;
  }
}
'@
if (-not ('LilinNative' -as [type])) { Add-Type -TypeDefinition $Native }

# ---------------------------------------------------------------- where we are
$Here = $PSScriptRoot
if (-not $AppDir) {
  $up = [IO.Path]::GetFullPath((Join-Path $Here '..\..'))
  if (Test-Path (Join-Path $up 'setup.js')) { $AppDir = $up }
}
$Fresh = -not $AppDir                       # true: download and install first
function Find-TaskDir {
  try {
    $t = Get-ScheduledTask -TaskName 'Lilin' -ErrorAction Stop
    if ($t.Actions[0].Arguments -match '"([^"]+)\\start-lilin\.cmd"') { return $Matches[1] }
  } catch { }
  $null
}
$DefaultDir = if ($AppDir) { $AppDir } elseif ($d = Find-TaskDir) { $d } else { Join-Path $env:USERPROFILE 'lilin' }

function Refresh-Path {
  $m = [Environment]::GetEnvironmentVariable('Path', 'Machine'); $usr = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($m, $usr) | Where-Object { $_ }) -join ';'
}
function Find-Node {
  Refresh-Path
  $c = Get-Command node -ErrorAction SilentlyContinue
  $path = if ($c) { $c.Source } elseif (Test-Path "$env:ProgramFiles\nodejs\node.exe") { "$env:ProgramFiles\nodejs\node.exe" } else { $null }
  if (-not $path) { return $null }
  try { $v = [version]((& $path --version).Trim().TrimStart('v')) } catch { return $null }
  [pscustomobject]@{ Path = $path; Version = $v; Ok = ($v -ge [version]'22.16.0') }
}
function Find-Winget {
  $c = Get-Command winget -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  $p = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'
  if (Test-Path $p) { return $p }
  $null
}

# ---------------------------------------------------------------- the window
[xml]$Xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Lilin Setup" Width="980" Height="700" MinWidth="760" MinHeight="520"
        WindowStartupLocation="CenterScreen" Background="#1F1019" FontFamily="Segoe UI" FontSize="14"
        TextOptions.TextFormattingMode="Display" UseLayoutRounding="True" SnapsToDevicePixels="True">
  <Window.Resources>
    <SolidColorBrush x:Key="Velvet" Color="#1F1019"/>
    <SolidColorBrush x:Key="Curtain" Color="#2B1724"/>
    <SolidColorBrush x:Key="Seat" Color="#3A2031"/>
    <SolidColorBrush x:Key="Line" Color="#4B2C3F"/>
    <SolidColorBrush x:Key="Paper" Color="#F6EADF"/>
    <SolidColorBrush x:Key="Dust" Color="#BA9DAD"/>
    <SolidColorBrush x:Key="Bulb" Color="#F4C152"/>
    <SolidColorBrush x:Key="Alert" Color="#FF9B85"/>
    <SolidColorBrush x:Key="Good" Color="#8FD6A3"/>

    <Style TargetType="TextBlock">
      <Setter Property="Foreground" Value="{StaticResource Paper}"/>
      <Setter Property="TextWrapping" Value="Wrap"/>
    </Style>
    <Style x:Key="Hint" TargetType="TextBlock">
      <Setter Property="Foreground" Value="{StaticResource Dust}"/>
      <Setter Property="FontSize" Value="12.5"/>
      <Setter Property="TextWrapping" Value="Wrap"/>
      <Setter Property="Margin" Value="0,5,0,0"/>
    </Style>
    <Style x:Key="Label" TargetType="TextBlock">
      <Setter Property="Foreground" Value="{StaticResource Paper}"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="Margin" Value="0,18,0,7"/>
    </Style>
    <Style x:Key="Section" TargetType="TextBlock">
      <Setter Property="Foreground" Value="{StaticResource Dust}"/>
      <Setter Property="FontSize" Value="11.5"/>
      <Setter Property="FontWeight" Value="Bold"/>
      <Setter Property="Margin" Value="0,24,0,2"/>
    </Style>
    <Style TargetType="Hyperlink">
      <Setter Property="Foreground" Value="{StaticResource Bulb}"/>
      <Setter Property="TextDecorations" Value="None"/>
    </Style>

    <Style x:Key="Field" TargetType="Control">
      <Setter Property="Foreground" Value="{StaticResource Paper}"/>
      <Setter Property="Background" Value="{StaticResource Seat}"/>
      <Setter Property="BorderBrush" Value="{StaticResource Line}"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="Padding" Value="10,0"/>
      <Setter Property="Height" Value="40"/>
      <Setter Property="FontSize" Value="14"/>
    </Style>
    <ControlTemplate x:Key="FieldTemplate" TargetType="Control">
      <Border x:Name="B" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}"
              BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="8">
        <ScrollViewer x:Name="PART_ContentHost" Margin="{TemplateBinding Padding}" VerticalAlignment="Center"/>
      </Border>
      <ControlTemplate.Triggers>
        <Trigger Property="IsKeyboardFocusWithin" Value="True"><Setter TargetName="B" Property="BorderBrush" Value="{StaticResource Bulb}"/></Trigger>
        <Trigger Property="IsEnabled" Value="False"><Setter Property="Opacity" Value="0.45"/></Trigger>
      </ControlTemplate.Triggers>
    </ControlTemplate>
    <Style TargetType="TextBox" BasedOn="{StaticResource Field}">
      <Setter Property="CaretBrush" Value="{StaticResource Bulb}"/>
      <Setter Property="SelectionBrush" Value="{StaticResource Bulb}"/>
      <Setter Property="Template" Value="{StaticResource FieldTemplate}"/>
    </Style>
    <Style TargetType="PasswordBox" BasedOn="{StaticResource Field}">
      <Setter Property="CaretBrush" Value="{StaticResource Bulb}"/>
      <Setter Property="SelectionBrush" Value="{StaticResource Bulb}"/>
      <Setter Property="Template" Value="{StaticResource FieldTemplate}"/>
    </Style>

    <Style x:Key="Btn" TargetType="Button">
      <Setter Property="Foreground" Value="{StaticResource Paper}"/>
      <Setter Property="Background" Value="{StaticResource Seat}"/>
      <Setter Property="BorderBrush" Value="{StaticResource Line}"/>
      <Setter Property="Padding" Value="18,9"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="B" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="1" CornerRadius="8">
              <ContentPresenter Margin="{TemplateBinding Padding}" HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="B" Property="BorderBrush" Value="{StaticResource Dust}"/></Trigger>
              <Trigger Property="IsKeyboardFocused" Value="True"><Setter TargetName="B" Property="BorderBrush" Value="{StaticResource Bulb}"/></Trigger>
              <Trigger Property="IsEnabled" Value="False"><Setter Property="Opacity" Value="0.4"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="Primary" TargetType="Button" BasedOn="{StaticResource Btn}">
      <Setter Property="Foreground" Value="#1F1019"/>
      <Setter Property="Background" Value="{StaticResource Bulb}"/>
      <Setter Property="BorderBrush" Value="{StaticResource Bulb}"/>
      <Setter Property="FontWeight" Value="Bold"/>
    </Style>
    <Style x:Key="Small" TargetType="Button" BasedOn="{StaticResource Btn}">
      <Setter Property="Padding" Value="14,7"/>
      <Setter Property="FontSize" Value="13"/>
    </Style>

    <!-- Choice cards: a radio button drawn as a selectable panel -->
    <Style x:Key="Card" TargetType="RadioButton">
      <Setter Property="Foreground" Value="{StaticResource Paper}"/>
      <Setter Property="Margin" Value="0,0,0,8"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="RadioButton">
            <Border x:Name="B" Background="{StaticResource Curtain}" BorderBrush="{StaticResource Line}" BorderThickness="1.5" CornerRadius="10" Padding="14,11">
              <Grid>
                <Grid.ColumnDefinitions><ColumnDefinition Width="Auto"/><ColumnDefinition/></Grid.ColumnDefinitions>
                <Grid Width="18" Height="18" Margin="0,1,12,0" VerticalAlignment="Top">
                  <Ellipse x:Name="Ring" Stroke="{StaticResource Dust}" StrokeThickness="1.5"/>
                  <Ellipse x:Name="Dot" Width="8" Height="8" Fill="{StaticResource Bulb}" Visibility="Collapsed"/>
                </Grid>
                <ContentPresenter Grid.Column="1"/>
              </Grid>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="B" Property="BorderBrush" Value="{StaticResource Dust}"/></Trigger>
              <Trigger Property="IsChecked" Value="True">
                <Setter TargetName="B" Property="BorderBrush" Value="{StaticResource Bulb}"/>
                <Setter TargetName="B" Property="Background" Value="#14F4C152"/>
                <Setter TargetName="Ring" Property="Stroke" Value="{StaticResource Bulb}"/>
                <Setter TargetName="Dot" Property="Visibility" Value="Visible"/>
              </Trigger>
              <Trigger Property="IsKeyboardFocused" Value="True"><Setter TargetName="B" Property="BorderBrush" Value="{StaticResource Bulb}"/></Trigger>
              <Trigger Property="IsEnabled" Value="False"><Setter Property="Opacity" Value="0.45"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style TargetType="CheckBox">
      <Setter Property="Foreground" Value="{StaticResource Paper}"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Margin" Value="0,10,0,0"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="CheckBox">
            <Grid Background="Transparent">
              <Grid.ColumnDefinitions><ColumnDefinition Width="Auto"/><ColumnDefinition/></Grid.ColumnDefinitions>
              <Border x:Name="Box" Width="20" Height="20" CornerRadius="5" BorderThickness="1.5" BorderBrush="{StaticResource Dust}"
                      Background="{StaticResource Seat}" VerticalAlignment="Top" Margin="0,0,11,0">
                <Path x:Name="Tick" Data="M 4,10 L 8,14 L 15,5" Stroke="#1F1019" StrokeThickness="2.2" Visibility="Collapsed"
                      StrokeStartLineCap="Round" StrokeEndLineCap="Round" StrokeLineJoin="Round"/>
              </Border>
              <ContentPresenter Grid.Column="1" VerticalAlignment="Center"/>
            </Grid>
            <ControlTemplate.Triggers>
              <Trigger Property="IsChecked" Value="True">
                <Setter TargetName="Box" Property="Background" Value="{StaticResource Bulb}"/>
                <Setter TargetName="Box" Property="BorderBrush" Value="{StaticResource Bulb}"/>
                <Setter TargetName="Tick" Property="Visibility" Value="Visible"/>
              </Trigger>
              <Trigger Property="IsKeyboardFocused" Value="True"><Setter TargetName="Box" Property="BorderBrush" Value="{StaticResource Bulb}"/></Trigger>
              <Trigger Property="IsEnabled" Value="False"><Setter Property="Opacity" Value="0.45"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <!-- On/off switch for the add-on -->
    <Style x:Key="Switch" TargetType="CheckBox">
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="CheckBox">
            <Border x:Name="Track" Width="46" Height="26" CornerRadius="13" Background="{StaticResource Seat}" BorderBrush="{StaticResource Dust}" BorderThickness="1.5">
              <Ellipse x:Name="Knob" Width="16" Height="16" Fill="{StaticResource Dust}" HorizontalAlignment="Left" Margin="4,0,0,0"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsChecked" Value="True">
                <Setter TargetName="Track" Property="Background" Value="{StaticResource Bulb}"/>
                <Setter TargetName="Track" Property="BorderBrush" Value="{StaticResource Bulb}"/>
                <Setter TargetName="Knob" Property="Fill" Value="#1F1019"/>
                <Setter TargetName="Knob" Property="HorizontalAlignment" Value="Right"/>
                <Setter TargetName="Knob" Property="Margin" Value="0,0,4,0"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style TargetType="ComboBoxItem">
      <Setter Property="Foreground" Value="{StaticResource Paper}"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="ComboBoxItem">
            <Border x:Name="B" Padding="12,8" Background="Transparent" CornerRadius="6"><ContentPresenter/></Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsHighlighted" Value="True"><Setter TargetName="B" Property="Background" Value="{StaticResource Seat}"/></Trigger>
              <Trigger Property="IsSelected" Value="True"><Setter Property="Foreground" Value="{StaticResource Bulb}"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style TargetType="ComboBox">
      <Setter Property="Foreground" Value="{StaticResource Paper}"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="ComboBox">
            <Grid>
              <ToggleButton x:Name="T" Focusable="False" ClickMode="Press"
                            IsChecked="{Binding IsDropDownOpen, Mode=TwoWay, RelativeSource={RelativeSource TemplatedParent}}">
                <ToggleButton.Template>
                  <ControlTemplate TargetType="ToggleButton">
                    <Border x:Name="B" Background="{StaticResource Seat}" BorderBrush="{StaticResource Line}" BorderThickness="1" CornerRadius="8">
                      <Path Data="M 0,0 L 5,5 L 10,0" Stroke="{StaticResource Dust}" StrokeThickness="1.6" HorizontalAlignment="Right" VerticalAlignment="Center" Margin="0,0,14,0"/>
                    </Border>
                    <ControlTemplate.Triggers>
                      <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="B" Property="BorderBrush" Value="{StaticResource Dust}"/></Trigger>
                    </ControlTemplate.Triggers>
                  </ControlTemplate>
                </ToggleButton.Template>
              </ToggleButton>
              <ContentPresenter Content="{TemplateBinding SelectionBoxItem}" ContentTemplate="{TemplateBinding SelectionBoxItemTemplate}"
                                IsHitTestVisible="False" Margin="12,9,40,9" VerticalAlignment="Center"/>
              <Popup IsOpen="{TemplateBinding IsDropDownOpen}" Placement="Bottom" AllowsTransparency="True" Focusable="False" PopupAnimation="Fade">
                <Border Background="{StaticResource Curtain}" BorderBrush="{StaticResource Line}" BorderThickness="1" CornerRadius="8" Padding="4" Margin="0,4,0,0"
                        MinWidth="{Binding ActualWidth, RelativeSource={RelativeSource TemplatedParent}}" MaxHeight="340">
                  <ScrollViewer VerticalScrollBarVisibility="Auto"><ItemsPresenter/></ScrollViewer>
                </Border>
              </Popup>
            </Grid>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style TargetType="ScrollBar">
      <Setter Property="Width" Value="8"/>
      <Setter Property="MinWidth" Value="8"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="ScrollBar">
            <Track x:Name="PART_Track" IsDirectionReversed="True">
              <Track.Thumb>
                <Thumb>
                  <Thumb.Template>
                    <ControlTemplate TargetType="Thumb"><Border Background="{StaticResource Line}" CornerRadius="4"/></ControlTemplate>
                  </Thumb.Template>
                </Thumb>
              </Track.Thumb>
            </Track>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
      <Style.Triggers>
        <Trigger Property="Orientation" Value="Horizontal"><Setter Property="Visibility" Value="Collapsed"/></Trigger>
      </Style.Triggers>
    </Style>

    <Style TargetType="ProgressBar">
      <Setter Property="Height" Value="4"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="ProgressBar">
            <Grid ClipToBounds="True">
              <Border x:Name="PART_Track" Background="{StaticResource Seat}" CornerRadius="2"/>
              <Border x:Name="PART_Indicator" Background="{StaticResource Bulb}" CornerRadius="2" HorizontalAlignment="Left"/>
              <Border x:Name="Sweep" Width="140" Background="{StaticResource Bulb}" CornerRadius="2" HorizontalAlignment="Left" Visibility="Collapsed">
                <Border.RenderTransform><TranslateTransform x:Name="SweepX" X="-140"/></Border.RenderTransform>
              </Border>
            </Grid>
            <ControlTemplate.Triggers>
              <Trigger Property="IsIndeterminate" Value="True">
                <Setter TargetName="PART_Indicator" Property="Visibility" Value="Collapsed"/>
                <Setter TargetName="Sweep" Property="Visibility" Value="Visible"/>
                <Trigger.EnterActions>
                  <BeginStoryboard x:Name="SweepRun">
                    <Storyboard RepeatBehavior="Forever">
                      <DoubleAnimation Storyboard.TargetName="SweepX" Storyboard.TargetProperty="X" From="-140" To="640" Duration="0:0:1.4"/>
                    </Storyboard>
                  </BeginStoryboard>
                </Trigger.EnterActions>
                <Trigger.ExitActions><StopStoryboard BeginStoryboardName="SweepRun"/></Trigger.ExitActions>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="Panel" TargetType="Border">
      <Setter Property="Background" Value="{StaticResource Curtain}"/>
      <Setter Property="BorderBrush" Value="{StaticResource Line}"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="CornerRadius" Value="10"/>
      <Setter Property="Padding" Value="16,13"/>
    </Style>
    <Style x:Key="Page" TargetType="StackPanel">
      <Setter Property="Visibility" Value="Collapsed"/>
    </Style>
  </Window.Resources>

  <Grid Background="{StaticResource Velvet}">
    <Grid.ColumnDefinitions><ColumnDefinition Width="250"/><ColumnDefinition/></Grid.ColumnDefinitions>

    <!-- Sidebar -->
    <Border Background="{StaticResource Curtain}" BorderBrush="{StaticResource Line}" BorderThickness="0,0,1,0">
      <DockPanel Margin="26,28,22,22">
        <StackPanel DockPanel.Dock="Top" Orientation="Horizontal" Margin="0,0,0,34">
          <Grid Width="46" Height="46">
            <Border CornerRadius="10" Background="#170B13" BorderBrush="{StaticResource Line}" BorderThickness="1"/>
            <Rectangle Margin="7" RadiusX="2" RadiusY="2" Stroke="{StaticResource Bulb}" StrokeThickness="3.2" StrokeDashArray="0 1.55" StrokeDashCap="Round"/>
            <TextBlock Text="M" FontSize="19" FontWeight="Black" Foreground="{StaticResource Paper}" HorizontalAlignment="Center" VerticalAlignment="Center" Margin="0,-1,0,0"/>
          </Grid>
          <StackPanel Margin="13,0,0,0" VerticalAlignment="Center">
            <TextBlock Text="Lilin" FontSize="20" FontWeight="Bold"/>
            <TextBlock Text="Setup" Foreground="{StaticResource Dust}" FontSize="12.5"/>
          </StackPanel>
        </StackPanel>
        <TextBlock x:Name="SideFoot" DockPanel.Dock="Bottom" Style="{StaticResource Hint}" FontSize="11.5"/>
        <StackPanel x:Name="Steps"/>
      </DockPanel>
    </Border>

    <!-- Content -->
    <Grid Grid.Column="1">
      <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
      <StackPanel Margin="44,34,44,6">
        <TextBlock x:Name="PageTitle" FontSize="26" FontWeight="SemiBold"/>
        <TextBlock x:Name="PageLead" Foreground="{StaticResource Dust}" Margin="0,6,0,0" MaxWidth="620" HorizontalAlignment="Left"/>
      </StackPanel>

      <ScrollViewer x:Name="Scroll" Grid.Row="1" VerticalScrollBarVisibility="Auto" Padding="44,6,30,24">
        <Grid>
          <Grid.ColumnDefinitions><ColumnDefinition Width="*" MaxWidth="620"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
          <!-- 0 Welcome -->
          <StackPanel x:Name="PWelcome" Style="{StaticResource Page}">
            <Border Style="{StaticResource Panel}" Margin="0,14,0,0">
              <StackPanel>
                <TextBlock x:Name="WelcomeState" FontWeight="SemiBold"/>
                <TextBlock x:Name="WelcomeStateHint" Style="{StaticResource Hint}"/>
              </StackPanel>
            </Border>
            <TextBlock Style="{StaticResource Section}" Text="WHAT HAPPENS"/>
            <StackPanel x:Name="WelcomeList" Margin="0,6,0,0"/>
            <TextBlock Style="{StaticResource Hint}" Margin="0,18,0,0" Text="You can come back and change anything later: run Lilin Setup again from the Start menu. Nothing is changed until you press Install on the last page."/>
          </StackPanel>

          <!-- 1 Install -->
          <StackPanel x:Name="PInstall" Style="{StaticResource Page}">
            <TextBlock Style="{StaticResource Label}" Text="Node.js"/>
            <Border Style="{StaticResource Panel}">
              <Grid>
                <Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
                <StackPanel VerticalAlignment="Center">
                  <TextBlock x:Name="NodeState" FontWeight="SemiBold"/>
                  <TextBlock x:Name="NodeHint" Style="{StaticResource Hint}"/>
                </StackPanel>
                <Button x:Name="NodeBtn" Grid.Column="1" Style="{StaticResource Small}" Content="Install Node.js" Margin="14,0,0,0" VerticalAlignment="Center"/>
              </Grid>
            </Border>
            <TextBlock Style="{StaticResource Label}" Text="Install Lilin in"/>
            <Grid>
              <Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
              <TextBox x:Name="InstallDir"/>
              <Button x:Name="InstallDirBtn" Grid.Column="1" Style="{StaticResource Small}" Content="Browse..." Margin="8,0,0,0"/>
            </Grid>
            <TextBlock x:Name="InstallDirHint" Style="{StaticResource Hint}"/>
            <Border x:Name="InstallProgress" Style="{StaticResource Panel}" Margin="0,22,0,0" Visibility="Collapsed">
              <StackPanel>
                <TextBlock x:Name="InstallProgressText" FontWeight="SemiBold"/>
                <ProgressBar x:Name="InstallBar" IsIndeterminate="True" Height="4" Margin="0,10,0,0" Foreground="{StaticResource Bulb}" Background="{StaticResource Seat}" BorderThickness="0"/>
                <TextBlock x:Name="InstallProgressLine" Style="{StaticResource Hint}" FontFamily="Cascadia Mono, Consolas" FontSize="11.5" TextTrimming="CharacterEllipsis" TextWrapping="NoWrap"/>
              </StackPanel>
            </Border>
          </StackPanel>

          <!-- 2 Library -->
          <StackPanel x:Name="PLibrary" Style="{StaticResource Page}">
            <TextBlock Style="{StaticResource Label}" Text="Films and shows folder"/>
            <Grid>
              <Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
              <TextBox x:Name="MediaDir"/>
              <Button x:Name="MediaDirBtn" Grid.Column="1" Style="{StaticResource Small}" Content="Browse..." Margin="8,0,0,0"/>
            </Grid>
            <TextBlock Style="{StaticResource Hint}" Text="Lilin plays what's in here and saves new downloads to it. It's created if it doesn't exist. A big drive is best."/>
            <StackPanel x:Name="DataBox">
              <TextBlock Style="{StaticResource Label}" Text="Database and settings folder (optional)"/>
              <Grid>
                <Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
                <TextBox x:Name="DataDir"/>
                <Button x:Name="DataDirBtn" Grid.Column="1" Style="{StaticResource Small}" Content="Browse..." Margin="8,0,0,0"/>
              </Grid>
              <TextBlock Style="{StaticResource Hint}" Text="Leave empty to keep it in the Lilin folder. Pick another folder to keep your data apart from the program, e.g. on a drive you back up."/>
              <TextBlock Style="{StaticResource Label}" Text="Cache folder (optional)"/>
              <Grid>
                <Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
                <TextBox x:Name="CacheDir"/>
                <Button x:Name="CacheDirBtn" Grid.Column="1" Style="{StaticResource Small}" Content="Browse..." Margin="8,0,0,0"/>
              </Grid>
              <TextBlock Style="{StaticResource Hint}" Text="Copies Lilin can always make again: versions for browsers and phones, previews and share copies. They can grow to hundreds of GB, so pick a big drive if C: is small. Leave empty to keep them with the database."/>
            </StackPanel>
            <TextBlock Style="{StaticResource Section}" Text="VIDEO TOOLS"/>
            <Border Style="{StaticResource Panel}" Margin="0,8,0,0">
              <StackPanel>
                <TextBlock x:Name="FfState" FontWeight="SemiBold"/>
                <TextBlock x:Name="FfHint" Style="{StaticResource Hint}"/>
                <CheckBox x:Name="FfInstall" Content="Install FFmpeg now (with winget)"/>
              </StackPanel>
            </Border>
          </StackPanel>

          <!-- 3 Network -->
          <StackPanel x:Name="PNetwork" Style="{StaticResource Page}">
            <TextBlock Style="{StaticResource Label}" Text="Port"/>
            <StackPanel Orientation="Horizontal">
              <TextBox x:Name="Port" Width="120"/>
              <TextBlock x:Name="PortState" Style="{StaticResource Hint}" VerticalAlignment="Center" Margin="14,0,0,0"/>
            </StackPanel>
            <TextBlock Style="{StaticResource Label}" Text="Who can open Lilin?"/>
            <RadioButton x:Name="HostLan" GroupName="host" Style="{StaticResource Card}">
              <StackPanel><TextBlock Text="Devices on my home network" FontWeight="SemiBold"/><TextBlock Style="{StaticResource Hint}" Margin="0,3,0,0" Text="Phones, TVs and laptops at home open it by this PC's address. Recommended."/></StackPanel>
            </RadioButton>
            <RadioButton x:Name="HostLocal" GroupName="host" Style="{StaticResource Card}">
              <StackPanel><TextBlock Text="Only this computer" FontWeight="SemiBold"/><TextBlock Style="{StaticResource Hint}" Margin="0,3,0,0" Text="For a tunnel or reverse proxy running on this PC that publishes it for you."/></StackPanel>
            </RadioButton>
            <TextBlock Style="{StaticResource Label}" Text="At home, do people need to sign in?"/>
            <RadioButton x:Name="HomeShared" GroupName="home" Style="{StaticResource Card}">
              <StackPanel><TextBlock Text="No, everyone at home shares one account" FontWeight="SemiBold"/><TextBlock Style="{StaticResource Hint}" Margin="0,3,0,0" Text="Easiest for a family. Visitors from the internet always have to sign in."/></StackPanel>
            </RadioButton>
            <RadioButton x:Name="HomeSignin" GroupName="home" Style="{StaticResource Card}">
              <StackPanel><TextBlock Text="Yes, everyone signs in, at home too" FontWeight="SemiBold"/><TextBlock Style="{StaticResource Hint}" Margin="0,3,0,0" Text="Each person gets their own watch history and lists."/></StackPanel>
            </RadioButton>
          </StackPanel>

          <!-- 4 Sign-in and remote access -->
          <StackPanel x:Name="PAccess" Style="{StaticResource Page}">
            <TextBlock Style="{StaticResource Label}" Text="Your email"/>
            <TextBox x:Name="OwnerEmail"/>
            <TextBlock Style="{StaticResource Hint}" Text="You become Lilin's owner: you see the House, Activity and Clips tabs and manage who has access."/>
            <StackPanel x:Name="PwBox">
              <Grid Margin="0,0,0,0">
                <Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="12"/><ColumnDefinition/></Grid.ColumnDefinitions>
                <StackPanel><TextBlock Style="{StaticResource Label}" Text="Password"/><PasswordBox x:Name="OwnerPw"/></StackPanel>
                <StackPanel Grid.Column="2"><TextBlock Style="{StaticResource Label}" Text="Password again"/><PasswordBox x:Name="OwnerPw2"/></StackPanel>
              </Grid>
              <TextBlock x:Name="PwHint" Style="{StaticResource Hint}" Text="At least 10 characters. For signing in from outside your home, and at home if everyone signs in."/>
            </StackPanel>
            <TextBlock Style="{StaticResource Label}" Text="Watching away from home"/>
            <RadioButton x:Name="RemoteNone" GroupName="remote" Style="{StaticResource Card}">
              <StackPanel><TextBlock Text="Not yet, home network only" FontWeight="SemiBold"/><TextBlock Style="{StaticResource Hint}" Margin="0,3,0,0" Text="Recommended to start. You can add this later."/></StackPanel>
            </RadioButton>
            <RadioButton x:Name="RemoteTailscale" GroupName="remote" Style="{StaticResource Card}">
              <StackPanel><TextBlock Text="Tailscale" FontWeight="SemiBold"/><TextBlock Style="{StaticResource Hint}" Margin="0,3,0,0" Text="Your own devices, anywhere. Install Tailscale on this PC and your phone."/></StackPanel>
            </RadioButton>
            <RadioButton x:Name="RemoteCloudflare" GroupName="remote" Style="{StaticResource Card}">
              <StackPanel><TextBlock Text="Cloudflare Tunnel and Access" FontWeight="SemiBold"/><TextBlock Style="{StaticResource Hint}" Margin="0,3,0,0" Text="Share with family and friends on your own web address, each with a personal account."/></StackPanel>
            </RadioButton>
            <RadioButton x:Name="RemoteProxy" GroupName="remote" Style="{StaticResource Card}">
              <StackPanel><TextBlock Text="My own reverse proxy" FontWeight="SemiBold"/><TextBlock Style="{StaticResource Hint}" Margin="0,3,0,0" Text="Caddy, nginx or similar, with its own sign-in in front of Lilin."/></StackPanel>
            </RadioButton>
            <StackPanel x:Name="CfBox" Margin="30,0,0,0">
              <TextBlock Style="{StaticResource Label}" Text="Access team domain (optional)"/>
              <TextBox x:Name="CfTeam"/>
              <TextBlock Style="{StaticResource Hint}" Text="e.g. myteam.cloudflareaccess.com. Leave empty to trust cloudflared running on this PC."/>
              <StackPanel x:Name="CfAudBox">
                <TextBlock Style="{StaticResource Label}" Text="Access application AUD tag"/>
                <PasswordBox x:Name="CfAud"/>
                <CheckBox x:Name="OidcOn" Content="People sign in to Access with their Lilin password" Margin="0,16,0,0"/>
                <TextBlock Style="{StaticResource Hint}" Margin="31,0,0,0" Text="Recommended. No one-time email codes, and an invite signs the new person straight in. At the end, Setup shows what to enter in Cloudflare."/>
              </StackPanel>
            </StackPanel>
            <StackPanel x:Name="UrlBox" Margin="30,0,0,0">
              <TextBlock Style="{StaticResource Label}" Text="Public address"/>
              <TextBox x:Name="PublicUrl"/>
              <TextBlock Style="{StaticResource Hint}" Text="e.g. https://lilin.example.com. Used for share links and the phone app."/>
            </StackPanel>
          </StackPanel>

          <!-- 5 Services -->
          <StackPanel x:Name="PServices" Style="{StaticResource Page}">
            <TextBlock Style="{StaticResource Label}" Text="TMDB token (posters, search and recommendations)"/>
            <PasswordBox x:Name="Tmdb"/>
            <TextBlock Style="{StaticResource Hint}"><Run x:Name="TmdbHint" Text="Free: themoviedb.org, Settings, API, then copy the API Read Access Token."/> <Hyperlink x:Name="TmdbLink" NavigateUri="https://www.themoviedb.org/settings/api">Get a token</Hyperlink></TextBlock>
            <TextBlock x:Name="TmdbState" Style="{StaticResource Hint}"/>
            <TextBlock Style="{StaticResource Label}" Text="OpenSubtitles API key (subtitles)"/>
            <PasswordBox x:Name="OpenSubs"/>
            <TextBlock Style="{StaticResource Hint}"><Run x:Name="OsHint" Text="Optional. opensubtitles.com, Profile, API consumers."/> <Hyperlink x:Name="OsLink" NavigateUri="https://www.opensubtitles.com/en/consumers">Get a key</Hyperlink></TextBlock>
            <TextBlock x:Name="OsState" Style="{StaticResource Hint}"/>
            <TextBlock Style="{StaticResource Label}" Text="Adult content"/>
            <ComboBox x:Name="ContentFilter">
              <ComboBoxItem Tag="on" Content="Hidden for everyone (recommended)"/>
              <ComboBoxItem Tag="members" Content="Hidden for everyone except you, the owner"/>
              <ComboBoxItem Tag="off" Content="Not hidden"/>
            </ComboBox>
            <TextBlock Style="{StaticResource Hint}" Text="Leaves adult titles and releases out of search, Discover and downloads."/>
            <TextBlock Style="{StaticResource Section}" Text="DOWNLOADS"/>
            <CheckBox x:Name="QbitOn" Content="Download with qBittorrent"/>
            <StackPanel x:Name="QbitBox" Margin="31,0,0,0">
              <TextBlock Style="{StaticResource Label}" Text="qBittorrent Web UI address"/>
              <TextBox x:Name="QbitUrl"/>
              <Grid>
                <Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="12"/><ColumnDefinition/></Grid.ColumnDefinitions>
                <StackPanel><TextBlock Style="{StaticResource Label}" Text="User"/><TextBox x:Name="QbitUser"/></StackPanel>
                <StackPanel Grid.Column="2"><TextBlock Style="{StaticResource Label}" Text="Password"/><PasswordBox x:Name="QbitPass"/></StackPanel>
              </Grid>
              <TextBlock Style="{StaticResource Hint}" Text="In qBittorrent: Tools, Options, Web UI. Turn it on and set a user name and password."/>
              <CheckBox x:Name="QbitPath" Content="Save qBittorrent's downloads in the films and shows folder"/>
              <TextBlock x:Name="QbitState" Style="{StaticResource Hint}"/>
            </StackPanel>
            <StackPanel Orientation="Horizontal" Margin="0,20,0,0">
              <Button x:Name="TestBtn" Style="{StaticResource Small}" Content="Test connections"/>
              <TextBlock x:Name="TestState" Style="{StaticResource Hint}" VerticalAlignment="Center" Margin="14,0,0,0"/>
            </StackPanel>
          </StackPanel>

          <!-- 6 Game clips (Clipper add-on) -->
          <StackPanel x:Name="PClips" Style="{StaticResource Page}">
            <Border Style="{StaticResource Panel}" Margin="0,14,0,0" Padding="18,16">
              <Grid>
                <Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
                <StackPanel>
                  <StackPanel Orientation="Horizontal">
                    <TextBlock Text="Clipper" FontSize="17" FontWeight="SemiBold"/>
                    <Border Background="{StaticResource Seat}" CornerRadius="6" Padding="7,2" Margin="10,1,0,0" VerticalAlignment="Center">
                      <TextBlock Text="ADD-ON" FontSize="10.5" FontWeight="Bold" Foreground="{StaticResource Bulb}"/>
                    </Border>
                  </StackPanel>
                  <TextBlock Style="{StaticResource Hint}" FontSize="13" Margin="0,6,0,0" Text="Keeps the last 90 seconds of your games in memory. Press Alt+F9 to save a clip; it shows up in Lilin's Clips tab, ready to trim and share on Discord."/>
                </StackPanel>
                <CheckBox x:Name="ClipsOn" Grid.Column="1" Style="{StaticResource Switch}" VerticalAlignment="Top" Margin="18,2,0,0"/>
              </Grid>
            </Border>
            <StackPanel x:Name="ClipsBox">
              <TextBlock Style="{StaticResource Label}" Text="Clips folder"/>
              <Grid>
                <Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
                <TextBox x:Name="ClipsDir"/>
                <Button x:Name="ClipsDirBtn" Grid.Column="1" Style="{StaticResource Small}" Content="Browse..." Margin="8,0,0,0"/>
              </Grid>
              <TextBlock Style="{StaticResource Label}" Text="Where do you play?"/>
              <RadioButton x:Name="WhereHere" GroupName="where" Style="{StaticResource Card}">
                <StackPanel><TextBlock Text="On this PC" FontWeight="SemiBold"/><TextBlock Style="{StaticResource Hint}" Margin="0,3,0,0" Text="Setup downloads Clipper and installs it here."/></StackPanel>
              </RadioButton>
              <RadioButton x:Name="WhereWindows" GroupName="where" Style="{StaticResource Card}">
                <StackPanel><TextBlock Text="On another Windows PC" FontWeight="SemiBold"/><TextBlock Style="{StaticResource Hint}" Margin="0,3,0,0" Text="You get one command to paste on that PC. Clips reach this one over a network share."/></StackPanel>
              </RadioButton>
              <RadioButton x:Name="WhereLinux" GroupName="where" Style="{StaticResource Card}">
                <StackPanel><TextBlock Text="On another Linux PC" FontWeight="SemiBold"/><TextBlock Style="{StaticResource Hint}" Margin="0,3,0,0" Text="Same, with a terminal command and a mount for the share."/></StackPanel>
              </RadioButton>
              <RadioButton x:Name="WhereNone" GroupName="where" Style="{StaticResource Card}">
                <StackPanel><TextBlock Text="Just the folder for now" FontWeight="SemiBold"/><TextBlock Style="{StaticResource Hint}" Margin="0,3,0,0" Text="The Clips tab appears; install Clipper later."/></StackPanel>
              </RadioButton>
              <StackPanel x:Name="QualityBox">
                <TextBlock Style="{StaticResource Label}" Text="Clip quality"/>
                <ComboBox x:Name="Quality"/>
                <TextBlock x:Name="QualityHint" Style="{StaticResource Hint}"/>
              </StackPanel>
              <StackPanel x:Name="ShareBox">
                <TextBlock x:Name="ShareLabel" Style="{StaticResource Label}" Text="How the gaming PC reaches the folder"/>
                <TextBox x:Name="SharePath"/>
                <CheckBox x:Name="ShareMake" Content="Share the clips folder on the network for me (asks for admin rights)"/>
              </StackPanel>
              <Border Style="{StaticResource Panel}" Margin="0,18,0,0">
                <StackPanel>
                  <TextBlock x:Name="ClipInstallsTitle" Text="Clipper will install" FontWeight="SemiBold"/>
                  <StackPanel x:Name="ClipInstalls" Margin="0,4,0,0"/>
                  <TextBlock Style="{StaticResource Hint}" Margin="0,10,0,0"><Run x:Name="ClipPin" Text="Clipper is separate open-source software."/> <Hyperlink x:Name="ClipLink">Review the source</Hyperlink></TextBlock>
                </StackPanel>
              </Border>
            </StackPanel>
          </StackPanel>

          <!-- 7 Startup -->
          <StackPanel x:Name="PStartup" Style="{StaticResource Page}">
            <Border Style="{StaticResource Panel}" Margin="0,14,0,0">
              <StackPanel>
                <CheckBox x:Name="AutoOn" Margin="0" Content="Start Lilin when this PC starts, before anyone signs in"/>
                <TextBlock x:Name="AutoHint" Style="{StaticResource Hint}" Margin="31,6,0,0" Text="Lilin runs as you, without admin rights, and restarts by itself within two minutes if it stops."/>
              </StackPanel>
            </Border>
            <StackPanel x:Name="WinPwBox">
              <TextBlock x:Name="WinPwLabel" Style="{StaticResource Label}" Text="Your Windows password"/>
              <PasswordBox x:Name="WinPw"/>
              <TextBlock Style="{StaticResource Hint}" Text="Windows needs it to start Lilin while nobody is signed in. With a Microsoft account, use that account's password, not your PIN. It's handed straight to Task Scheduler and not saved by Lilin."/>
              <TextBlock x:Name="WinPwState" Style="{StaticResource Hint}"/>
              <TextBlock Style="{StaticResource Hint}" Margin="0,12,0,0" Foreground="{StaticResource Bulb}" Text="Windows asks for permission once (an admin prompt) when this step runs."/>
            </StackPanel>
          </StackPanel>

          <!-- 8 Review -->
          <StackPanel x:Name="PReview" Style="{StaticResource Page}">
            <StackPanel x:Name="ReviewList" Margin="0,10,0,0"/>
          </StackPanel>

          <!-- 9 Progress -->
          <StackPanel x:Name="PProgress" Style="{StaticResource Page}">
            <StackPanel x:Name="ProgressList" Margin="0,12,0,0"/>
            <ProgressBar x:Name="ProgressBar" Height="4" Margin="0,16,0,0" Foreground="{StaticResource Bulb}" Background="{StaticResource Seat}" BorderThickness="0"/>
            <TextBlock Style="{StaticResource Section}" Text="DETAILS"/>
            <TextBox x:Name="Log" IsReadOnly="True" Height="220" Margin="0,8,0,0" FontFamily="Cascadia Mono, Consolas" FontSize="12"
                     VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled" TextWrapping="Wrap" Padding="10,8" AcceptsReturn="True">
              <TextBox.Template>
                <ControlTemplate TargetType="TextBox">
                  <Border Background="#170B13" BorderBrush="{StaticResource Line}" BorderThickness="1" CornerRadius="8">
                    <ScrollViewer x:Name="PART_ContentHost" Margin="{TemplateBinding Padding}"/>
                  </Border>
                </ControlTemplate>
              </TextBox.Template>
            </TextBox>
          </StackPanel>

          <!-- 10 Done -->
          <StackPanel x:Name="PDone" Style="{StaticResource Page}">
            <Border Style="{StaticResource Panel}" Margin="0,14,0,0" Padding="20,18">
              <Grid>
                <Grid.ColumnDefinitions><ColumnDefinition/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
                <StackPanel VerticalAlignment="Center">
                  <TextBlock Text="Open Lilin at" Style="{StaticResource Hint}" Margin="0"/>
                  <TextBlock x:Name="DoneUrl" FontSize="19" FontWeight="SemiBold" Foreground="{StaticResource Bulb}" Margin="0,3,0,0"/>
                  <TextBlock x:Name="DoneUrlHint" Style="{StaticResource Hint}"/>
                </StackPanel>
                <StackPanel Grid.Column="1" VerticalAlignment="Center" Margin="16,0,0,0">
                  <Button x:Name="OpenBtn" Style="{StaticResource Primary}" Content="Open Lilin"/>
                  <Button x:Name="StartBtn" Style="{StaticResource Small}" Content="Start Lilin" Margin="0,8,0,0"/>
                </StackPanel>
              </Grid>
            </Border>
            <StackPanel x:Name="RemoteBox">
              <TextBlock Style="{StaticResource Section}" Text="ON YOUR GAMING PC"/>
              <TextBlock x:Name="RemoteLead" Style="{StaticResource Hint}" FontSize="13"/>
              <TextBox x:Name="RemoteCmd" IsReadOnly="True" TextWrapping="Wrap" Height="Auto" Padding="10,8" FontFamily="Cascadia Mono, Consolas" FontSize="11.5" Margin="0,8,0,0"/>
              <Button x:Name="CopyBtn" Style="{StaticResource Small}" Content="Copy command" HorizontalAlignment="Left" Margin="0,8,0,0"/>
            </StackPanel>
            <StackPanel x:Name="OidcBox" Visibility="Collapsed">
              <TextBlock Style="{StaticResource Section}" Text="IN CLOUDFLARE ACCESS"/>
              <TextBlock x:Name="OidcLead" Style="{StaticResource Hint}" FontSize="13" Text="Add Lilin as a login method, so people sign in with their Lilin password. It includes a secret: paste it only into Cloudflare. To see it again later, run node setup.js oidc in the Lilin folder."/>
              <TextBox x:Name="OidcText" IsReadOnly="True" TextWrapping="Wrap" Height="Auto" Padding="10,8" FontFamily="Cascadia Mono, Consolas" FontSize="11.5" Margin="0,8,0,0"/>
              <Button x:Name="OidcCopy" Style="{StaticResource Small}" Content="Copy" HorizontalAlignment="Left" Margin="0,8,0,0"/>
            </StackPanel>
            <StackPanel x:Name="TodoBox">
              <TextBlock Style="{StaticResource Section}" Text="STILL TO DO"/>
              <StackPanel x:Name="TodoList" Margin="0,6,0,0"/>
            </StackPanel>
            <StackPanel Orientation="Horizontal" Margin="0,22,0,0">
              <Button x:Name="LogBtn" Style="{StaticResource Small}" Content="Show details"/>
            </StackPanel>
          </StackPanel>
        </Grid>
      </ScrollViewer>

      <!-- Footer -->
      <Border Grid.Row="2" BorderBrush="{StaticResource Line}" BorderThickness="0,1,0,0" Padding="44,16">
        <Grid>
          <TextBlock x:Name="FootMsg" VerticalAlignment="Center" Foreground="{StaticResource Alert}" FontSize="13" Margin="0,0,220,0"/>
          <StackPanel Orientation="Horizontal" HorizontalAlignment="Right">
            <Button x:Name="CancelBtn" Style="{StaticResource Btn}" Content="Cancel" Margin="0,0,10,0" Background="Transparent" BorderBrush="Transparent"/>
            <Button x:Name="BackBtn" Style="{StaticResource Btn}" Content="Back" Margin="0,0,10,0"/>
            <Button x:Name="NextBtn" Style="{StaticResource Primary}" Content="Next" MinWidth="110" IsDefault="True"/>
          </StackPanel>
        </Grid>
      </Border>
    </Grid>
  </Grid>
</Window>
'@

$Win = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $Xaml))
$U = @{}
foreach ($n in $Xaml.SelectNodes('//*[@*[local-name()="Name"]][not(ancestor::*[local-name()="ControlTemplate"])]')) {
  $name = $n.GetAttribute('Name', 'http://schemas.microsoft.com/winfx/2006/xaml')
  if ($name -and -not $U.ContainsKey($name)) { $U[$name] = $Win.FindName($name) }
}
$B = @{}
foreach ($k in 'Paper', 'Dust', 'Bulb', 'Alert', 'Good', 'Line', 'Seat', 'Curtain', 'Velvet') { $B[$k] = $Win.Resources[$k] }

# ---------------------------------------------------------------- state
$S = @{
  Info = $null; Node = $null; Page = 0; Busy = $false; NextConfirmed = $null
  Log = New-Object Text.StringBuilder; Todo = New-Object Collections.ArrayList
  ClipPlan = $null; Url = $null; Running = $false; TempFiles = New-Object Collections.ArrayList
  InstallDone = $false
}
$Jobs = New-Object Collections.ArrayList
$Waits = New-Object Collections.ArrayList
$Http = New-Object Net.Http.HttpClient
$Http.Timeout = [TimeSpan]::FromSeconds(3)

$Pages = @(
  @{ Key = 'PWelcome'; Side = 'Welcome' }
  @{ Key = 'PInstall'; Side = 'Install' }
  @{ Key = 'PLibrary'; Side = 'Library' }
  @{ Key = 'PNetwork'; Side = 'Network' }
  @{ Key = 'PAccess'; Side = 'Sign-in' }
  @{ Key = 'PServices'; Side = 'Services' }
  @{ Key = 'PClips'; Side = 'Game clips' }
  @{ Key = 'PStartup'; Side = 'Startup' }
  @{ Key = 'PReview'; Side = 'Review' }
  @{ Key = 'PProgress'; Side = 'Finish' }
  @{ Key = 'PDone'; Side = 'Finish' }
)
function Page-Index([string]$key) { for ($i = 0; $i -lt $Pages.Count; $i++) { if ($Pages[$i].Key -eq $key) { return $i } }; -1 }
function Page-Skipped([int]$i) { $Pages[$i].Key -eq 'PInstall' -and -not $Fresh }

# ---------------------------------------------------------------- small helpers
function Quote-Arg([string]$a) {
  if ($a -ne '' -and $a -notmatch '[\s"]') { return $a }
  '"' + ($a -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}
function Add-Log([string]$line) {
  [void]$S.Log.AppendLine($line)
  $U.Log.AppendText($line + "`r`n"); $U.Log.ScrollToEnd()
}
function Set-Foot([string]$msg) { $U.FootMsg.Text = $msg }
function New-Text([string]$text, [string]$style = '', $brush = $null) {
  $t = New-Object Windows.Controls.TextBlock
  $t.Text = $text
  if ($style) { $t.Style = $Win.Resources[$style] }
  if ($brush) { $t.Foreground = $brush }
  $t
}
# A glyph + text row; .Tag holds the parts that change (Glyph, Title).
function Bullet-Row([string]$glyph, $brush, [string]$title, [string]$detail = '') {
  $g = New-Object Windows.Controls.Grid
  $g.Margin = '0,0,0,10'
  $c1 = New-Object Windows.Controls.ColumnDefinition; $c1.Width = 'Auto'
  [void]$g.ColumnDefinitions.Add($c1); [void]$g.ColumnDefinitions.Add((New-Object Windows.Controls.ColumnDefinition))
  $i = New-Text $glyph '' $brush
  $i.Width = 26; $i.FontWeight = 'Bold'; $i.FontSize = 14
  $sp = New-Object Windows.Controls.StackPanel
  [Windows.Controls.Grid]::SetColumn($sp, 1)
  $t = New-Text $title '' $B.Paper; [void]$sp.Children.Add($t)
  if ($detail) { $d = New-Text $detail 'Hint'; $d.Margin = '0,2,0,0'; [void]$sp.Children.Add($d) }
  [void]$g.Children.Add($i); [void]$g.Children.Add($sp)
  $g.Tag = @{ Glyph = $i; Title = $t }
  $g
}
function Write-TempJson($obj) {
  $f = Join-Path ([IO.Path]::GetTempPath()) ("lilin-setup-" + [guid]::NewGuid().ToString('N') + '.json')
  [IO.File]::WriteAllText($f, ($obj | ConvertTo-Json -Depth 5 -Compress), (New-Object Text.UTF8Encoding $false))
  [void]$S.TempFiles.Add($f)
  $f
}
function Remove-Temp([string]$f) { if ($f) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue; [void]$S.TempFiles.Remove($f) } }
function Open-Url([string]$usr) { try { Start-Process $usr } catch { } }
function Glyph([string]$name) { @{ ok = [string][char]0x2713; warn = '!'; err = [string][char]0x2715; dot = [string][char]0x2022; run = [string][char]0x25CF; skip = [string][char]0x2013 }[$name] }
$Dash = [string][char]0x2013

# ---------------------------------------------------------------- background work
# Output is read with ReadLineAsync and collected on the UI thread by a timer, so the window never
# freezes and no PowerShell code runs on another thread. Callbacks are plain script blocks called
# from the timer (so they see this script's functions and variables); whatever they need from the
# moment they were set up travels in $ctx. (GetNewClosure would hide the script's functions.)
function Start-Proc {
  param([string]$File, [string[]]$Arguments = @(), [hashtable]$Env = @{}, [scriptblock]$OnLine = $null, [scriptblock]$OnExit, [string]$Cwd = '', $Ctx = @{})
  Refresh-Path
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $File
  $psi.Arguments = (@($Arguments) | ForEach-Object { Quote-Arg $_ }) -join ' '
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.RedirectStandardInput = $true
  $psi.StandardOutputEncoding = [Text.Encoding]::UTF8; $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
  $psi.WorkingDirectory = if ($Cwd) { $Cwd } elseif ($S.Info -and $S.Info.appDir) { $S.Info.appDir } else { $env:TEMP }
  $psi.EnvironmentVariables['Path'] = $env:Path
  $psi.EnvironmentVariables['NO_COLOR'] = '1'
  $psi.EnvironmentVariables['NODE_NO_WARNINGS'] = '1'
  foreach ($k in $Env.Keys) { $psi.EnvironmentVariables[$k] = [string]$Env[$k] }
  try { $p = [Diagnostics.Process]::Start($psi) }
  catch { $ctx = $Ctx; & $OnExit -1 '' "Couldn't start ${File}: $($_.Exception.Message)" $ctx; return }
  $p.StandardInput.Close()
  $j = [pscustomobject]@{ P = $p; Out = $p.StandardOutput.ReadLineAsync(); Err = $p.StandardError.ReadLineAsync(); OutDone = $false; ErrDone = $false
    Stdout = New-Object Text.StringBuilder; Stderr = New-Object Text.StringBuilder; OnLine = $OnLine; OnExit = $OnExit; Ctx = $Ctx }
  [void]$Jobs.Add($j)
}
# `node setup.js wizard ACTION`; $OnDone gets (parsed JSON or $null, error text, $Ctx).
function Wizard-Json([string]$action, $answers, [scriptblock]$OnDone, [string]$inDir = '', $Ctx = @{}) {
  $wargs = @('wizard', $action)
  $f = $null
  if ($answers) { $f = Write-TempJson $answers; $wargs += @('--config', $f) }
  $setupJs = Join-Path $(if ($inDir) { $inDir } else { $S.Info.appDir }) 'setup.js'
  Start-Proc -File $S.Node.Path -Arguments (@($setupJs) + $wargs) -Cwd (Split-Path $setupJs) -Ctx @{ File = $f; Cb = $OnDone; Inner = $Ctx } -OnExit {
    param($code, $out, $err, $ctx)
    Remove-Temp $ctx.File
    $obj = $null
    if ($code -eq 0) { try { $obj = ($out.Trim() -split "`n")[-1] | ConvertFrom-Json } catch { $err = "Unreadable answer from setup.js: $out" } }
    $why = if ($obj) { $null } else { @($err.Trim(), $out.Trim()) | Where-Object { $_ } | Select-Object -First 1 }
    & $ctx.Cb $obj $why $ctx.Inner
  }
}
# Calls $Then (with $Ctx) once $Until (with $Ctx) returns true; checked on every timer tick.
function Wait-For([scriptblock]$Until, [scriptblock]$Then, $Ctx = @{}) { [void]$Waits.Add([pscustomobject]@{ Until = $Until; Then = $Then; Ctx = $Ctx }) }
# Polls Lilin's /api/health until it answers or $seconds pass; $Then gets $true/$false.
function Wait-Lilin([int]$seconds, [scriptblock]$Then) {
  Wait-For -Ctx @{ Port = $U.Port.Text.Trim(); Deadline = (Get-Date).AddSeconds($seconds); Task = $null; Ok = $false; Then = $Then } -Until {
    param($ctx)
    if ($ctx.Task -and $ctx.Task.IsCompleted) {
      $ctx.Ok = $ctx.Task.Status -eq 'RanToCompletion' -and $ctx.Task.Result.IsSuccessStatusCode
      $ctx.Task = $null
      if ($ctx.Ok) { return $true }
    }
    if ((Get-Date) -gt $ctx.Deadline) { return $true }
    if (-not $ctx.Task) { $ctx.Task = $Http.GetAsync("http://127.0.0.1:$($ctx.Port)/api/health") }
    $false
  } -Then { param($ctx) if ($ctx.Ok) { $S.Running = $true }; & $ctx.Then $ctx.Ok }
}

$Timer = New-Object Windows.Threading.DispatcherTimer
$Timer.Interval = [TimeSpan]::FromMilliseconds(80)
$Timer.add_Tick({
  foreach ($j in @($Jobs)) {
    foreach ($stream in 'Out', 'Err') {
      while (-not $j."${stream}Done" -and $j.$stream.IsCompleted) {
        $line = $j.$stream.Result
        if ($null -eq $line) { $j."${stream}Done" = $true; break }
        if ($stream -eq 'Out') { [void]$j.Stdout.AppendLine($line); $j.Out = $j.P.StandardOutput.ReadLineAsync() }
        else { [void]$j.Stderr.AppendLine($line); $j.Err = $j.P.StandardError.ReadLineAsync() }
        if ($j.OnLine) { try { & $j.OnLine $line $j.Ctx } catch { Add-Log "  (display error: $($_.Exception.Message))" } }
      }
    }
    if ($j.OutDone -and $j.ErrDone -and $j.P.HasExited) {
      [void]$Jobs.Remove($j)
      $j.P.WaitForExit()
      try { & $j.OnExit $j.P.ExitCode $j.Stdout.ToString() $j.Stderr.ToString() $j.Ctx } catch { Add-Log "Error: $($_.Exception.Message)"; Fail-Step $_.Exception.Message }
    }
  }
  foreach ($w in @($Waits)) {
    $done = $false
    try { $done = & $w.Until $w.Ctx } catch { $done = $true }
    if ($done) { [void]$Waits.Remove($w); try { & $w.Then $w.Ctx } catch { Add-Log "Error: $($_.Exception.Message)"; Fail-Step $_.Exception.Message } }
  }
})
$Timer.Start()

# ---------------------------------------------------------------- sidebar
$Side = @{}
function Build-Sidebar {
  $U.Steps.Children.Clear(); $Side.Clear()
  foreach ($p in $Pages) {
    if ($Side.ContainsKey($p.Side)) { continue }
    if ($p.Key -eq 'PInstall' -and -not $Fresh) { continue }
    $g = New-Object Windows.Controls.Grid
    $g.Margin = '0,0,0,4'
    $c = New-Object Windows.Controls.ColumnDefinition; $c.Width = 'Auto'
    [void]$g.ColumnDefinitions.Add($c); [void]$g.ColumnDefinitions.Add((New-Object Windows.Controls.ColumnDefinition))
    $dot = New-Object Windows.Controls.Border
    $dot.Width = 24; $dot.Height = 24; $dot.CornerRadius = 12; $dot.BorderThickness = 1.5; $dot.Margin = '0,6,12,6'
    $num = New-Text ''; $num.FontSize = 11.5; $num.FontWeight = 'Bold'; $num.HorizontalAlignment = 'Center'; $num.VerticalAlignment = 'Center'
    $dot.Child = $num
    $t = New-Text $p.Side; $t.VerticalAlignment = 'Center'; $t.FontSize = 14
    [Windows.Controls.Grid]::SetColumn($t, 1)
    [void]$g.Children.Add($dot); [void]$g.Children.Add($t)
    [void]$U.Steps.Children.Add($g)
    $Side[$p.Side] = @{ Dot = $dot; Num = $num; Text = $t; N = $Side.Count + 1 }
  }
}
function Update-Sidebar {
  $current = $Pages[$S.Page].Side
  $order = @($Side.Keys | Sort-Object { $Side[$_].N })
  $ci = [array]::IndexOf($order, $current)
  for ($i = 0; $i -lt $order.Count; $i++) {
    $e = $Side[$order[$i]]
    if ($i -lt $ci -or ($current -eq 'Finish' -and $Pages[$S.Page].Key -eq 'PDone')) {
      $e.Dot.Background = $B.Bulb; $e.Dot.BorderBrush = $B.Bulb; $e.Num.Text = Glyph ok; $e.Num.Foreground = $B.Velvet; $e.Text.Foreground = $B.Paper; $e.Text.FontWeight = 'Normal'
    } elseif ($i -eq $ci) {
      $e.Dot.Background = $B.Seat; $e.Dot.BorderBrush = $B.Bulb; $e.Num.Text = [string]$e.N; $e.Num.Foreground = $B.Bulb; $e.Text.Foreground = $B.Paper; $e.Text.FontWeight = 'SemiBold'
    } else {
      $e.Dot.Background = $null; $e.Dot.BorderBrush = $B.Line; $e.Num.Text = [string]$e.N; $e.Num.Foreground = $B.Dust; $e.Text.Foreground = $B.Dust; $e.Text.FontWeight = 'Normal'
    }
  }
}

# ---------------------------------------------------------------- pages: filling in
$Titles = @{
  PWelcome = @('Welcome', '')
  PInstall = @('Install Lilin', 'Lilin runs on Node.js. Setup downloads the release, checks it against its published checksum and unpacks it.')
  PLibrary = @('Your library', 'Where your films and shows live.')
  PNetwork = @('Network', 'How phones, TVs and other computers reach Lilin.')
  PAccess = @('Sign-in and remote access', 'Your owner account, and whether Lilin should be reachable outside your home.')
  PServices = @('Services', 'Optional, but they make Lilin much better. Paste a key, or leave a box empty to skip it.')
  PClips = @('Game clips', 'An optional add-on: record your best moments and share them from Lilin.')
  PStartup = @('Start at boot', 'Lilin is a server: it works best when it starts with the PC.')
  PReview = @('Ready to install', 'Check your choices. Nothing has changed yet.')
  PProgress = @('Setting up Lilin', 'This takes a minute or two. Larger downloads (Node.js, FFmpeg, Clipper) take longer.')
  PDone = @('Lilin is ready', '')
}

function Fill-Welcome {
  $U.WelcomeList.Children.Clear()
  if ($Fresh) {
    $U.WelcomeState.Text = 'Lilin will be installed on this PC'
    $U.WelcomeStateHint.Text = 'A self-hosted media server for your films and shows: watch on phones, TVs and browsers, with downloads, subtitles and casting.'
    $items = @(
      @('Install', 'Node.js if it''s missing, then the latest Lilin release.'),
      @('Set up', 'Your library folder, network, sign-in and the services you use.'),
      @('Game clips (optional)', 'Clipper records your games; clips land in Lilin.'),
      @('Start at boot', 'So Lilin is always there, even before you sign in.'))
  } else {
    $v = if ($S.Info) { $S.Info.version } else { '' }
    $U.WelcomeState.Text = "Lilin $v in $AppDir"
    $U.WelcomeStateHint.Text = if ($S.Info -and $S.Info.envExists) { 'Your current settings are filled in. Change what you like; everything else is kept as it is.' } else { 'Not set up yet. Setup fills in sensible defaults for this PC.' }
    $items = @(
      @('Settings', 'Library, network, sign-in and services.'),
      @('Game clips (optional)', 'Add Clipper, or point the Clips tab at a folder.'),
      @('Start at boot', 'Register or refresh the Lilin task.'),
      @('Restart', 'Lilin restarts at the end so the changes take effect.'))
  }
  $n = 1
  foreach ($it in $items) { [void]$U.WelcomeList.Children.Add((Bullet-Row ([string]$n) $B.Bulb $it[0] $it[1])); $n++ }
}

function Fill-NodeState {
  $S.Node = Find-Node
  if ($S.Node -and $S.Node.Ok) {
    $U.NodeState.Text = "$(Glyph ok)  Node.js $($S.Node.Version) is installed"; $U.NodeState.Foreground = $B.Paper
    $U.NodeHint.Text = $S.Node.Path; $U.NodeBtn.Visibility = 'Collapsed'
  } else {
    $U.NodeState.Text = if ($S.Node) { "Node.js $($S.Node.Version) is too old" } else { 'Node.js is not installed' }
    $U.NodeState.Foreground = $B.Bulb
    $wg = Find-Winget
    $U.NodeHint.Text = if ($wg) { 'Lilin needs Node.js 22.16 or later. Setup installs the current LTS for you (with winget) when you press Install.' } else { 'Lilin needs Node.js 22.16 or later. Install the LTS from nodejs.org, then press Install.' }
    $U.NodeBtn.Content = 'Open nodejs.org'
    $U.NodeBtn.Visibility = Vis (-not $wg)
  }
}

function Fill-InstallDirHint {
  $d = $U.InstallDir.Text.Trim()
  $U.InstallDirHint.Text = if (-not $d) { '' }
    elseif (Test-Path (Join-Path $d '.git')) { 'This is a git checkout: Setup uses it as it is (update it with git).' }
    elseif (Test-Path (Join-Path $d 'package.json')) { try { "Lilin $(((Get-Content (Join-Path $d 'package.json') -Raw) | ConvertFrom-Json).version) is installed here: it's updated, and your settings and data are kept." } catch { 'An existing installation: updated in place, settings and data kept.' } }
    else { 'A new folder for the program, its settings and (unless you pick another folder later) its database.' }
}

# Fills the setting pages from `wizard info`.
function Fill-FromInfo {
  $i = $S.Info; $v = $i.values; $d = $i.defaults
  $U.SideFoot.Text = "Lilin $($i.version)`n$($i.appDir)"
  $U.MediaDir.Text = $d.MEDIA_DIR
  $U.DataDir.Text = $d.DATA_DIR
  $U.CacheDir.Text = [string]$d.CACHE_DIR
  $U.ContentFilter.SelectedIndex = [Math]::Max(0, [array]::IndexOf(@('on', 'members', 'off'), [string]$d.CONTENT_FILTER))
  $U.DataBox.Visibility = if ($i.freshInstall) { 'Visible' } else { 'Collapsed' }
  if ($i.ffmpeg) {
    $U.FfState.Text = "$(Glyph ok)  FFmpeg $($i.ffmpeg.version)"; $U.FfHint.Text = $i.ffmpeg.path; $U.FfInstall.Visibility = 'Collapsed'; $U.FfInstall.IsChecked = $false
  } else {
    $U.FfState.Text = 'FFmpeg is not installed'
    $U.FfHint.Text = 'Lilin uses it to convert videos so every device can play them, for subtitle timing, previews and clip sharing. Without it those stay off.'
    $wg = Find-Winget
    $U.FfInstall.Visibility = if ($wg) { 'Visible' } else { 'Collapsed' }; $U.FfInstall.IsChecked = [bool]$wg
    if (-not $wg) { $U.FfHint.Text += ' Install it from gyan.dev/ffmpeg and run Setup again.' }
  }
  $U.Port.Text = $d.PORT
  $U.HostLan.IsChecked = $d.HOST -ne '127.0.0.1'; $U.HostLocal.IsChecked = $d.HOST -eq '127.0.0.1'
  $U.HomeShared.IsChecked = $d.HOME_NETWORK_ACCESS -ne 'signin'; $U.HomeSignin.IsChecked = $d.HOME_NETWORK_ACCESS -eq 'signin'
  $owner = [string]$v.ADMIN_EMAILS
  $U.OwnerEmail.Text = ($owner -split ',')[0].Trim()
  $U.RemoteNone.IsChecked = $d.remoteAccess -eq 'none'; $U.RemoteCloudflare.IsChecked = $d.remoteAccess -eq 'cloudflare'
  $U.RemoteProxy.IsChecked = $d.remoteAccess -eq 'proxy'; $U.RemoteTailscale.IsChecked = $false
  $U.CfTeam.Text = [string]$v.CF_ACCESS_TEAM_DOMAIN
  $U.PublicUrl.Text = [string]$v.PUBLIC_URL
  $U.OidcOn.IsChecked = $d.accessSignIn -ne 'access'
  foreach ($pair in @(@('Tmdb', 'TMDB_TOKEN'), @('OpenSubs', 'OPENSUBTITLES_API_KEY'), @('QbitPass', 'QBIT_PASS'), @('CfAud', 'CF_ACCESS_AUD'))) {
    $box = $U[$pair[0]]
    $box.Tag = [bool]($i.secrets.($pair[1]))
    $box.ToolTip = if ($box.Tag) { 'Saved. Leave empty to keep it, or paste a new one.' } else { $null }
  }
  $U.TmdbState.Text = if ($U.Tmdb.Tag) { "$(Glyph ok)  A token is saved. Leave the box empty to keep it." } else { '' }
  $U.OsState.Text = if ($U.OpenSubs.Tag) { "$(Glyph ok)  A key is saved. Leave the box empty to keep it." } else { '' }
  $U.QbitOn.IsChecked = [bool]$v.QBIT_URL
  $U.QbitUrl.Text = if ($v.QBIT_URL) { $v.QBIT_URL } else { 'http://localhost:8081' }
  $U.QbitUser.Text = if ($v.QBIT_USER) { $v.QBIT_USER } else { 'admin' }
  $U.QbitPath.IsChecked = $true
  $U.QbitState.Text = if ($U.QbitPass.Tag) { "$(Glyph ok)  A password is saved. Leave it empty to keep it." } else { '' }
  # Clips
  $U.ClipsOn.IsChecked = [bool]$v.CLIPS_DIR
  $U.ClipsDir.Text = $d.CLIPS_DIR
  $U.WhereHere.IsChecked = -not $i.clipper.installedHere; $U.WhereNone.IsChecked = [bool]$i.clipper.installedHere
  $U.Quality.Items.Clear()
  foreach ($q in $i.clipper.quality) {
    $item = New-Object Windows.Controls.ComboBoxItem
    $parts = $q.label -split ': ', 2
    $item.Content = if ($q.value -like 'bench:*') { 'Measure my PC ' + ($parts[0] -replace '^benchmark ', '') + "  $Dash  " + ($parts[1] -replace '^measure the PC, ', '') }
      else { (Get-Culture).TextInfo.ToTitleCase($parts[0]) + "  $Dash  " + $parts[1] }
    $item.Tag = $q.value
    [void]$U.Quality.Items.Add($item)
  }
  $U.Quality.SelectedIndex = 0
  $U.ClipLink.NavigateUri = [uri]$i.clipper.source
  $U.ClipPin.Text = "Clipper is separate open-source software. Setup installs one reviewed version ($($i.clipper.commit.Substring(0, 12))) and checks the download against its hash first."
  # Startup
  $U.AutoOn.IsChecked = -not $i.autostart
  $U.AutoOn.Content = if ($i.autostart) { 'Register the Lilin task again (it already starts at boot)' } else { 'Start Lilin when this PC starts, before anyone signs in' }
  $U.WinPwLabel.Text = "Windows password for $env:USERNAME"
  Update-Visibility
}

function Selected-Remote { foreach ($n in 'None', 'Tailscale', 'Cloudflare', 'Proxy') { if ($U["Remote$n"].IsChecked) { return $n.ToLower() } }; 'none' }
function Selected-Where { foreach ($n in 'Here', 'Windows', 'Linux', 'None') { if ($U["Where$n"].IsChecked) { return $n.ToLower() } }; 'here' }
function Selected-Quality { if ($U.Quality.SelectedItem) { [string]$U.Quality.SelectedItem.Tag } else { 'balanced' } }
function Vis([bool]$on) { if ($on) { 'Visible' } else { 'Collapsed' } }
# Lilin as Cloudflare Access's sign-in: needs Cloudflare and a team domain (its callback lives there).
function Oidc-On { (Selected-Remote) -eq 'cloudflare' -and $U.CfTeam.Text.Trim() -ne '' -and [bool]$U.OidcOn.IsChecked }
function Selected-Filter { if ($U.ContentFilter.SelectedItem) { [string]$U.ContentFilter.SelectedItem.Tag } else { 'on' } }

function Update-Visibility {
  $remote = Selected-Remote
  $U.CfBox.Visibility = Vis ($remote -eq 'cloudflare')
  $U.CfAudBox.Visibility = Vis ($U.CfTeam.Text.Trim() -ne '')
  $U.UrlBox.Visibility = Vis ($remote -in 'cloudflare', 'proxy')
  $hasLogin = $S.Info -and $S.Info.ownerHasLogin -and $S.Info.logins -contains $U.OwnerEmail.Text.Trim().ToLower()
  $U.PwHint.Text = if ($hasLogin) { "$(Glyph ok)  You already have a Lilin password. Type a new one only to change it." }
    elseif (Oidc-On) { 'At least 10 characters. Needed: Cloudflare Access signs you in with this password.' }
    elseif ($remote -eq 'cloudflare') { 'Optional with Cloudflare Access (it signs people in). A password also lets you sign in at home.' }
    else { 'At least 10 characters. You sign in with it from outside your home, and at home if everyone signs in.' }
  $U.QbitBox.Visibility = Vis ([bool]$U.QbitOn.IsChecked)
  $U.ClipsBox.Visibility = Vis ([bool]$U.ClipsOn.IsChecked)
  $where = Selected-Where
  $U.QualityBox.Visibility = Vis ($where -ne 'none')
  $U.ShareBox.Visibility = Vis ($where -in 'windows', 'linux')
  $U.ShareMake.Visibility = Vis ($where -in 'windows', 'linux')
  $U.ShareLabel.Text = if ($where -eq 'linux') { 'Where the gaming PC mounts the folder' } else { 'How the gaming PC reaches the folder' }
  $q = Selected-Quality
  $U.QualityHint.Text = if ($q -like 'bench:*') { 'Clipper records 8 seconds of you playing and picks the settings: have a game running when it counts down.' } else { 'You can change this later in Clipper.' }
  $U.WinPwBox.Visibility = Vis ([bool]$U.AutoOn.IsChecked)
  $U.AutoHint.Visibility = Vis ([bool]$U.AutoOn.IsChecked -or -not ($S.Info -and $S.Info.autostart))
}

# The Clipper box shows what will be installed for the current choice.
function Refresh-ClipPlan {
  if (-not $S.Info -or -not $U.ClipsOn.IsChecked) { return }
  $ans = @{ CLIPS_DIR = $U.ClipsDir.Text.Trim(); where = (Selected-Where); quality = (Selected-Quality); MEDIA_DIR = $U.MediaDir.Text.Trim(); PORT = $U.Port.Text.Trim() }
  if ($U.SharePath.Tag -eq 'typed' -and $U.SharePath.Text.Trim()) { $ans.share = $U.SharePath.Text.Trim() }
  Wizard-Json 'clipper' $ans {
    param($plan, $err)
    if (-not $plan) { return }
    $S.ClipPlan = $plan
    $U.ClipInstalls.Children.Clear()
    $U.ClipInstallsTitle.Text = switch ($plan.where) { 'here' { 'Clipper will install on this PC' } 'none' { 'Setup will only create the folder' } default { 'On the gaming PC, Clipper installs' } }
    foreach ($l in @($plan.installs)) { if ($l) { $r = Bullet-Row (Glyph dot) $B.Dust $l; $r.Margin = '0,4,0,0'; $r.Tag.Title.FontSize = 13; [void]$U.ClipInstalls.Children.Add($r) } }
    if ($plan.where -eq 'none') { [void]$U.ClipInstalls.Children.Add((New-Text "$($plan.clipsDir)\Kept, which Lilin's Clips tab shows." 'Hint')) }
    if ($plan.share -and $U.SharePath.Tag -ne 'typed') { $U.SharePath.Text = $plan.share }
  }
}

function Field-Error([string]$msg, $focus) { Set-Foot $msg; if ($focus) { $focus.Focus() | Out-Null }; $false }

# Checks a page before leaving it. Returns $false (and says why) to stay.
function Validate-Page([string]$key) {
  Set-Foot ''
  switch ($key) {
    'PInstall' {
      if (-not $U.InstallDir.Text.Trim()) { return Field-Error 'Choose a folder for Lilin.' $U.InstallDir }
      try { [IO.Path]::GetFullPath($U.InstallDir.Text.Trim()) | Out-Null } catch { return Field-Error 'That folder path isn''t valid.' $U.InstallDir }
    }
    'PLibrary' {
      $m = $U.MediaDir.Text.Trim()
      if (-not $m) { return Field-Error 'Choose the folder with your films and shows.' $U.MediaDir }
      if (-not [IO.Path]::IsPathRooted($m)) { return Field-Error 'Use a full path, like D:\Media.' $U.MediaDir }
      $dd = $U.DataDir.Text.Trim()
      if ($dd -and -not [IO.Path]::IsPathRooted($dd)) { return Field-Error 'Use a full path for the database folder, or leave it empty.' $U.DataDir }
      $cd = $U.CacheDir.Text.Trim()
      if ($cd -and -not [IO.Path]::IsPathRooted($cd)) { return Field-Error 'Use a full path for the cache folder, or leave it empty.' $U.CacheDir }
    }
    'PNetwork' {
      $p = 0
      if (-not [int]::TryParse($U.Port.Text.Trim(), [ref]$p) -or $p -lt 1 -or $p -gt 65535) { return Field-Error 'The port is a number from 1 to 65535 (8080 is usual).' $U.Port }
      if ($U.PortState.Tag -eq 'busy') { return Field-Error "Port $p is used by another program. Pick another, like $($p + 1)." $U.Port }
    }
    'PAccess' {
      $e = $U.OwnerEmail.Text.Trim()
      if ($e -and $e -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') { return Field-Error 'That doesn''t look like an email address.' $U.OwnerEmail }
      $pw = $U.OwnerPw.Password
      if ($pw -or $U.OwnerPw2.Password) {
        if (-not $e) { return Field-Error 'Add your email: the password belongs to it.' $U.OwnerEmail }
        if ($pw.Length -lt 10) { return Field-Error 'Use at least 10 characters for the password.' $U.OwnerPw }
        $local = ($e -split '@')[0]
        if ($local.Length -ge 4 -and $pw.ToLower().Contains($local.ToLower())) { return Field-Error 'Don''t use your email name in the password.' $U.OwnerPw }
        if ($pw -ne $U.OwnerPw2.Password) { return Field-Error 'The two passwords don''t match.' $U.OwnerPw2 }
      } elseif ($U.HomeSignin.IsChecked -and $e -and -not ($S.Info.logins -contains $e.ToLower()) -and (Selected-Remote) -ne 'cloudflare') {
        return Field-Error 'Everyone signs in (Network page), so set a password, or nobody can get in.' $U.OwnerPw
      }
      if ((Selected-Remote) -eq 'cloudflare' -and -not $e) { return Field-Error 'Cloudflare Access needs the owner''s email (as you sign in there).' $U.OwnerEmail }
      if ((Oidc-On) -and -not $pw -and -not ($S.Info.logins -contains $e.ToLower())) { return Field-Error 'Access will sign people in with Lilin passwords: set yours, or you can''t get in from outside.' $U.OwnerPw }
      if ((Oidc-On) -and -not $U.PublicUrl.Text.Trim()) { return Field-Error 'Signing in with Lilin passwords needs the public address.' $U.PublicUrl }
      if ((Selected-Remote) -in 'cloudflare', 'proxy' -and $U.PublicUrl.Text.Trim() -and $U.PublicUrl.Text.Trim() -notmatch '^https?://') { return Field-Error 'The public address starts with https://' $U.PublicUrl }
    }
    'PServices' {
      if ($U.QbitOn.IsChecked -and $U.QbitUrl.Text.Trim() -notmatch '^https?://') { return Field-Error 'The qBittorrent address starts with http://, like http://localhost:8081' $U.QbitUrl }
    }
    'PClips' {
      if ($U.ClipsOn.IsChecked) {
        $c = $U.ClipsDir.Text.Trim()
        if (-not $c -or -not [IO.Path]::IsPathRooted($c)) { return Field-Error 'Choose a full path for the clips folder.' $U.ClipsDir }
        if ((Selected-Where) -in 'windows', 'linux' -and -not $U.SharePath.Text.Trim()) { return Field-Error 'Say how the gaming PC reaches the folder.' $U.SharePath }
      }
    }
    'PStartup' {
      if ($U.AutoOn.IsChecked) {
        if (-not $U.WinPw.Password) { return Field-Error 'Type your Windows password, or untick the box to skip this.' $U.WinPw }
        $r = [LilinNative]::CheckPassword($env:USERNAME, $env:USERDOMAIN, $U.WinPw.Password)
        if ($r -eq 0 -and $S.NextConfirmed -ne 'PStartup') {
          $U.WinPwState.Text = "Windows didn't accept that password. Check it (not your PIN), or press Next again to use it anyway."
          $U.WinPwState.Foreground = $B.Alert
          $S.NextConfirmed = 'PStartup'
          return $false
        }
        $U.WinPwState.Text = if ($r -eq 1) { "$(Glyph ok)  Password checked" } else { '' }
        $U.WinPwState.Foreground = $B.Good
      }
    }
  }
  $S.NextConfirmed = $null
  $true
}

# ---------------------------------------------------------------- review and the plan
function Answers {
  $a = [ordered]@{}
  $a.MEDIA_DIR = $U.MediaDir.Text.Trim()
  if ($S.Info.freshInstall) { $a.DATA_DIR = $U.DataDir.Text.Trim(); $a.CACHE_DIR = $U.CacheDir.Text.Trim() }
  $a.PORT = $U.Port.Text.Trim()
  $a.HOST = if ($U.HostLocal.IsChecked) { '127.0.0.1' } else { '0.0.0.0' }
  $a.HOME_NETWORK_ACCESS = if ($U.HomeSignin.IsChecked) { 'signin' } else { 'shared' }
  $remote = Selected-Remote
  $a.remoteAccess = $remote
  $a.ADMIN_EMAILS = $(if ($U.OwnerEmail.Text.Trim()) {
      # keep any other owners already listed
      $others = @(([string]$S.Info.values.ADMIN_EMAILS -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Skip 1)
      (@($U.OwnerEmail.Text.Trim().ToLower()) + $others) -join ','
    } else { '' })
  if ($remote -eq 'cloudflare') {
    $a.CF_ACCESS_TEAM_DOMAIN = $U.CfTeam.Text.Trim()
    if ($U.CfAud.Password) { $a.CF_ACCESS_AUD = $U.CfAud.Password }
    $a.accessSignIn = if (Oidc-On) { 'lilin' } else { 'access' }
  }
  if ($remote -in 'cloudflare', 'proxy') { $a.PUBLIC_URL = $U.PublicUrl.Text.Trim() }
  if ($U.Tmdb.Password) { $a.TMDB_TOKEN = $U.Tmdb.Password.Trim() }
  if ($U.OpenSubs.Password) { $a.OPENSUBTITLES_API_KEY = $U.OpenSubs.Password.Trim() }
  $a.CONTENT_FILTER = Selected-Filter
  if ($U.QbitOn.IsChecked) {
    $a.QBIT_URL = $U.QbitUrl.Text.Trim(); $a.QBIT_USER = $U.QbitUser.Text.Trim()
    if ($U.QbitPass.Password) { $a.QBIT_PASS = $U.QbitPass.Password }
    $a.qbitSavePath = [bool]$U.QbitPath.IsChecked
  } else { $a.QBIT_URL = '' }
  if (-not $U.ClipsOn.IsChecked -and $S.Info.values.CLIPS_DIR) { $a.CLIPS_DIR = '' }   # turns the Clips tab off
  $a.autostart = $false        # registered separately, elevated
  $a.install = @()             # FFmpeg is installed by the wizard (winget needs agreement flags)
  $a
}

function Review-Row([string]$title, [string]$detail) {
  $card = New-Object Windows.Controls.Border
  $card.Style = $Win.Resources['Panel']; $card.Margin = '0,0,0,8'; $card.Padding = '16,10'
  $g = New-Object Windows.Controls.Grid
  $c = New-Object Windows.Controls.ColumnDefinition; $c.Width = '170'
  [void]$g.ColumnDefinitions.Add($c); [void]$g.ColumnDefinitions.Add((New-Object Windows.Controls.ColumnDefinition))
  $t = New-Text $title 'Hint'; $t.Margin = '0'; $t.FontSize = 13
  $d = New-Text $detail; $d.FontSize = 13.5
  [Windows.Controls.Grid]::SetColumn($d, 1)
  [void]$g.Children.Add($t); [void]$g.Children.Add($d)
  $card.Child = $g
  [void]$U.ReviewList.Children.Add($card)
}

function Fill-Review {
  $U.ReviewList.Children.Clear()
  $a = Answers
  if ($Fresh) { Review-Row 'Install' ("Lilin $(if ($Version) { $Version } else { '(latest release)' }) in $($U.InstallDir.Text.Trim())") }
  Review-Row 'Library' $a.MEDIA_DIR
  if ($a.DATA_DIR) { Review-Row 'Database' $a.DATA_DIR }
  if ($a.CACHE_DIR) { Review-Row 'Cache' $a.CACHE_DIR }
  if ($U.FfInstall.IsChecked -and $U.FfInstall.Visibility -eq 'Visible') { Review-Row 'FFmpeg' 'Install with winget' }
  Review-Row 'Address' ("Port $($a.PORT), " + $(if ($a.HOST -eq '127.0.0.1') { 'this computer only' } else { 'whole home network' }) + ', ' + $(if ($a.HOME_NETWORK_ACCESS -eq 'signin') { 'everyone signs in' } else { 'no sign-in at home' }))
  $owner = if ($a.ADMIN_EMAILS) { ($a.ADMIN_EMAILS -split ',')[0] } else { 'none' }
  Review-Row 'Owner' ($owner + $(if ($U.OwnerPw.Password) { ', new password' } elseif ($S.Info.logins -contains $owner) { ', existing password' } else { '' }))
  Review-Row 'Remote access' (@{ none = 'Home network only'; tailscale = 'Tailscale'; cloudflare = 'Cloudflare Tunnel and Access'; proxy = 'Your reverse proxy' }[$a.remoteAccess] + $(if ($a.PUBLIC_URL) { " ($($a.PUBLIC_URL))" } else { '' }) + $(if ($a.accessSignIn -eq 'lilin') { ', sign in with Lilin passwords' } else { '' }))
  $svc = @()
  if ($a.TMDB_TOKEN -or $U.Tmdb.Tag) { $svc += 'TMDB' }
  if ($a.OPENSUBTITLES_API_KEY -or $U.OpenSubs.Tag) { $svc += 'OpenSubtitles' }
  if ($a.QBIT_URL) { $svc += "qBittorrent ($($a.QBIT_URL))" }
  Review-Row 'Services' $(if ($svc) { $svc -join ', ' } else { 'None' })
  Review-Row 'Adult content' (@{ on = 'Hidden for everyone'; members = 'Hidden, except for you'; off = 'Not hidden' }[$a.CONTENT_FILTER])
  if ($U.ClipsOn.IsChecked) {
    $where = @{ here = 'Clipper installed on this PC'; windows = 'Clipper on another Windows PC (command shown at the end)'; linux = 'Clipper on another Linux PC (command shown at the end)'; none = 'folder only' }[(Selected-Where)]
    $qual = if ((Selected-Where) -ne 'none' -and $U.Quality.SelectedItem) { ', ' + (([string]$U.Quality.SelectedItem.Content -split "  $Dash  ")[0]).ToLower() } else { '' }
    Review-Row 'Game clips' "$($U.ClipsDir.Text.Trim()): $where$qual"
  } else { Review-Row 'Game clips' 'Not now' }
  Review-Row 'Start at boot' $(if ($U.AutoOn.IsChecked) { 'Yes (Windows asks for admin permission once)' } elseif ($S.Info.autostart) { 'Already set up' } else { 'No: start it from the last page' })
}

# ---------------------------------------------------------------- running the plan
$Run = @{ Steps = @(); Index = -1; Rows = @{}; Failed = $false }
function Add-Step([string]$id, [string]$label, [scriptblock]$Do) { $Run.Steps += [pscustomobject]@{ Id = $id; Label = $label; Do = $Do; Status = 'wait' } }
function Set-Row($step, [string]$status, [string]$detail = '') {
  $step.Status = $status
  $r = $Run.Rows[$step.Id].Tag
  $map = @{ wait = @((Glyph dot), $B.Line); run = @((Glyph run), $B.Bulb); ok = @((Glyph ok), $B.Good); warn = @('!', $B.Bulb); err = @((Glyph err), $B.Alert); skip = @((Glyph skip), $B.Dust) }
  $r.Glyph.Text = $map[$status][0]; $r.Glyph.Foreground = $map[$status][1]
  $r.Title.Foreground = if ($status -eq 'wait') { $B.Dust } else { $B.Paper }
  $r.Title.FontWeight = if ($status -eq 'run') { 'SemiBold' } else { 'Normal' }
  if ($detail) { $r.Title.Text = "$($step.Label)  $Dash  $detail" }
}
function Next-Step {
  $Run.Index++
  $U.ProgressBar.Value = [math]::Min(100, 100 * $Run.Index / [math]::Max(1, $Run.Steps.Count))
  if ($Run.Index -ge $Run.Steps.Count) { Finish-Run; return }
  $st = $Run.Steps[$Run.Index]
  Set-Row $st 'run'
  Add-Log ''; Add-Log "== $($st.Label)"
  try { & $st.Do } catch { Fail-Step $_.Exception.Message }
}
function Step-Ok([string]$detail = '') { $st = $Run.Steps[$Run.Index]; Set-Row $st 'ok' $detail; Next-Step }
function Step-Warn([string]$detail, [string]$todo = '') { $st = $Run.Steps[$Run.Index]; Set-Row $st 'warn' $detail; if ($todo) { [void]$S.Todo.Add($todo) }; Next-Step }
function Step-Skip([string]$detail = '') { $st = $Run.Steps[$Run.Index]; Set-Row $st 'skip' $detail; Next-Step }
function Fail-Step([string]$msg) {
  if ($Run.Index -lt 0 -or $Run.Index -ge $Run.Steps.Count) { Set-Foot $msg; $S.Busy = $false; Update-Buttons; return }
  $st = $Run.Steps[$Run.Index]
  Set-Row $st 'err' $msg
  Add-Log "Failed: $msg"
  $Run.Failed = $true
  foreach ($r in $Run.Steps[($Run.Index + 1)..($Run.Steps.Count)]) { if ($r) { Set-Row $r 'skip' } }
  $U.PageTitle.Text = 'Setup stopped'
  $U.PageLead.Text = 'One step failed; see the details below. Fix it and press Try again: steps that already worked are safe to repeat.'
  $S.Busy = $false
  Update-Buttons
  if ($TestRun) { End-TestRun 1 }
}
# Runs a process as one step: output goes to the log. Without -Then, exit code 0 = ok.
# -Then gets ($code, $out, $err, $ctx).
function Proc-Step([string]$File, [string[]]$Arguments, [hashtable]$Env = @{}, [scriptblock]$Then = $null, $Ctx = @{}) {
  Start-Proc -File $File -Arguments $Arguments -Env $Env -Ctx @{ Then = $Then; Inner = $Ctx } -OnLine { param($l) Add-Log "  $l" } -OnExit {
    param($code, $out, $err, $ctx)
    if ($ctx.Then) { & $ctx.Then $code $out $err $ctx.Inner } elseif ($code -eq 0) { Step-Ok } else { Fail-Step "exit code $code" }
  }
}
function Setup-Js { Join-Path $S.Info.appDir 'setup.js' }

function Build-Plan {
  $Run.Steps = @(); $Run.Index = -1; $Run.Failed = $false; $S.Todo.Clear()
  $clips = [bool]$U.ClipsOn.IsChecked
  $where = Selected-Where

  if ($U.FfInstall.IsChecked -and $U.FfInstall.Visibility -eq 'Visible') {
    Add-Step 'ffmpeg' 'Install FFmpeg' {
      Proc-Step (Find-Winget) @('install', '--id', 'Gyan.FFmpeg', '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity') -Then {
        param($code)
        Refresh-Path
        if ($code -eq 0 -or (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { Step-Ok }
        else { Step-Warn "winget exit code $code" 'Install FFmpeg (winget install Gyan.FFmpeg), then restart Lilin' }
      }
    }
  }
  Add-Step 'config' 'Save settings' {
    $f = Write-TempJson (Answers)
    $flags = @('--config', $f)
    if ($U.QbitOn.IsChecked -and $U.QbitPath.IsChecked) { $flags += '--allow-qbit-config' }
    Proc-Step $S.Node.Path (@((Setup-Js)) + $flags) -Ctx @{ File = $f } -Then {
      param($code, $out, $err, $ctx)
      Remove-Temp $ctx.File
      if ($code -ne 0) { Fail-Step 'setup.js stopped (see details)'; return }
      $todo = $false; $summary = $false
      foreach ($l in ($out -split "`r?`n")) {
        if ($l -match '^Summary') { $summary = $true; continue }
        if ($l -match '^\s+Open:') { $summary = $false }
        if ($summary -and $l -match '^! (.+)$') { [void]$S.Todo.Add($Matches[1]) }
        if ($l -match '^Still to do') { $todo = $true; continue }
        if ($todo -and $l -match '^\s+-\s+(.+)$' -and $Matches[1] -notmatch 'Create your sign-in|Cloudflare|reverse|Tailscale|authenticating proxy') { [void]$S.Todo.Add($Matches[1]) }
      }
      Step-Ok
    }
  }
  if ($U.OwnerPw.Password) {
    Add-Step 'owner' "Set the password for $($U.OwnerEmail.Text.Trim().ToLower())" {
      Proc-Step $S.Node.Path @((Setup-Js), 'user', 'add', $U.OwnerEmail.Text.Trim().ToLower()) -Env @{ LILIN_PASSWORD = $U.OwnerPw.Password }
    }
  }
  if ($clips) {
    $label = switch ($where) { 'here' { 'Install Clipper (game clips)' } 'none' { 'Create the clips folder' } default { 'Set up the clips folder' } }
    Add-Step 'clipper' $label {
      $c = @{ CLIPS_DIR = $U.ClipsDir.Text.Trim(); where = (Selected-Where); quality = (Selected-Quality) }
      if ($U.SharePath.Text.Trim()) { $c.share = $U.SharePath.Text.Trim() }
      $f = Write-TempJson $c
      Proc-Step $S.Node.Path @((Setup-Js), 'clipper', '--config', $f, '--allow-install') -Ctx @{ File = $f } -Then {
        param($code, $out, $err, $ctx)
        Remove-Temp $ctx.File
        if ($code -eq 0) { Step-Ok } else { Step-Warn 'Clipper''s installer failed (see details)' 'Install Clipper again: run Lilin Setup, Game clips' }
      }
    }
  }
  $share = $clips -and $where -in 'windows', 'linux' -and $U.ShareMake.IsChecked
  if ($U.AutoOn.IsChecked -or $share) {
    $label = if ($U.AutoOn.IsChecked -and $share) { 'Start at boot and share the clips folder' } elseif ($share) { 'Share the clips folder' } else { 'Start Lilin at boot' }
    Add-Step 'elevated' $label { Run-Elevated }
  }
  if (-not $U.AutoOn.IsChecked -and $S.Info.autostart) {
    Add-Step 'restart' 'Restart Lilin' {
      Proc-Step $S.Node.Path @((Setup-Js), 'service', 'restart') -Then {
        param($code) if ($code -eq 0) { Step-Ok } else { Step-Warn 'restart failed' 'Restart Lilin: Start menu, Lilin Setup, or restart the PC' }
      }
    }
  }
  if ($U.AutoOn.IsChecked -or $S.Info.autostart) {
    Add-Step 'health' 'Wait for Lilin to answer' {
      Wait-Lilin 60 {
        param($ok)
        if ($ok) { Step-Ok 'running' } else { Step-Warn 'no answer yet' "Lilin didn't answer within a minute: see $($S.Info.appDir)\logs\lilin.log" }
      }
    }
  }
  if (-not $TestRun) { Add-Step 'shortcut' 'Add Lilin to the Start menu' { Make-Shortcuts; Step-Ok } }
}

# One admin prompt for the steps that need it: registering the task and sharing the clips folder.
function Run-Elevated {
  $log = Join-Path ([IO.Path]::GetTempPath()) ("lilin-setup-admin-" + [guid]::NewGuid().ToString('N') + '.log')
  $q = { param($st) "'" + ($st -replace "'", "''") + "'" }
  $lines = @('$ErrorActionPreference = ''Stop''', "`$log = $(& $q $log)", 'function L($m) { Add-Content -LiteralPath $log -Value $m -Encoding UTF8 }', 'try {')
  $cred = $null
  if ($U.AutoOn.IsChecked) {
    $cred = Join-Path ([IO.Path]::GetTempPath()) ("lilin-setup-" + [guid]::NewGuid().ToString('N') + '.key')
    $U.WinPw.SecurePassword | ConvertFrom-SecureString | Set-Content -LiteralPath $cred -Encoding ASCII
    [void]$S.TempFiles.Add($cred)
    $svc = Join-Path $S.Info.appDir 'scripts\windows\install-service.ps1'
    $lines += "  & $(& $q $svc) -CredentialFile $(& $q $cred) *>&1 | ForEach-Object { L ([string]`$_) }"
    $lines += '  if (-not (Get-ScheduledTask -TaskName ''Lilin'' -ErrorAction SilentlyContinue)) { throw ''The Lilin task was not registered'' }'
  }
  if ($U.ClipsOn.IsChecked -and (Selected-Where) -in 'windows', 'linux' -and $U.ShareMake.IsChecked) {
    $dir = $U.ClipsDir.Text.Trim()
    $name = if ($S.ClipPlan -and $S.ClipPlan.shareName) { $S.ClipPlan.shareName } else { 'Clips' }
    $who = "$env:USERDOMAIN\$env:USERNAME"
    $lines += "  New-Item -ItemType Directory -Force $(& $q (Join-Path $dir 'Kept')) | Out-Null"
    $lines += "  if (Get-SmbShare -Name $(& $q $name) -ErrorAction SilentlyContinue) { L $(& $q "The share $name already exists; left as it is") }"
    $lines += "  else { New-SmbShare -Name $(& $q $name) -Path $(& $q $dir) -ChangeAccess $(& $q $who) | Out-Null; L $(& $q "Shared $dir as \\$env:COMPUTERNAME\$name (change access: $who)") }"
  }
  $lines += "  L 'LILIN-SETUP-OK'", '} catch { L ("ERROR: " + $_.Exception.Message) }'
  $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes(($lines -join "`n")))
  Add-Log '  Waiting for the Windows admin prompt...'
  try {
    $p = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -PassThru -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $enc
  } catch {
    Remove-Temp $cred
    Step-Warn 'not done: the admin prompt was declined' 'Start at boot: run Lilin Setup again and accept the admin prompt'
    return
  }
  Wait-For -Ctx @{ P = $p; Log = $log; Cred = $cred } -Until { param($ctx) $ctx.P.HasExited } -Then {
    param($ctx)
    Remove-Temp $ctx.Cred
    $text = if (Test-Path $ctx.Log) { Get-Content -LiteralPath $ctx.Log -Raw -Encoding UTF8 } else { '' }
    Remove-Item -LiteralPath $ctx.Log -Force -ErrorAction SilentlyContinue
    foreach ($l in ($text -split "`r?`n")) { if ($l -and $l -ne 'LILIN-SETUP-OK') { Add-Log "  $l" } }
    if ($text -match 'LILIN-SETUP-OK') { Step-Ok }
    elseif ($text -match 'ERROR: (.+)') { Fail-Step $Matches[1].Trim() }
    else { Fail-Step 'the admin step ended without a result' }
  }
}

function Make-Shortcuts {
  try {
    $menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Lilin'
    New-Item -ItemType Directory -Force $menu | Out-Null
    $sh = New-Object -ComObject WScript.Shell
    $exe = Join-Path $S.Info.appDir 'LilinSetup.exe'
    if ($LauncherPath -and (Test-Path $LauncherPath) -and ([IO.Path]::GetFullPath($LauncherPath) -ne [IO.Path]::GetFullPath($exe))) { Copy-Item -LiteralPath $LauncherPath $exe -Force }
    $lnk = $sh.CreateShortcut((Join-Path $menu 'Lilin Setup.lnk'))
    if (Test-Path $exe) { $lnk.TargetPath = $exe; $lnk.Arguments = '' }
    else {
      $lnk.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
      $lnk.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $S.Info.appDir 'scripts\windows\setup-wizard.ps1') + '"'
      $lnk.WindowStyle = 7
    }
    $lnk.WorkingDirectory = $S.Info.appDir
    $lnk.Description = 'Change Lilin''s settings, add game clips, update'
    $lnk.Save()
    $url = Join-Path $menu 'Lilin.url'
    [IO.File]::WriteAllText($url, "[InternetShortcut]`r`nURL=$(Lilin-Url -local)`r`n")
    Add-Log "  Start menu: $menu"
  } catch { Add-Log "  Couldn't add Start menu entries: $($_.Exception.Message)" }
}

function Lilin-Url([switch]$local) {
  $port = $U.Port.Text.Trim()
  if ($local -or $U.HostLocal.IsChecked) { return "http://localhost:$port" }
  $lan = @($S.Info.lan)[0]
  "http://$(if ($lan) { $lan } else { $env:COMPUTERNAME.ToLower() }):$port"
}

function Start-Run {
  $S.Busy = $true
  $U.Log.Clear(); $U.ProgressList.Children.Clear(); $Run.Rows = @{}
  Build-Plan
  foreach ($st in $Run.Steps) { $r = Bullet-Row (Glyph dot) $B.Line $st.Label; $Run.Rows[$st.Id] = $r; [void]$U.ProgressList.Children.Add($r); Set-Row $st 'wait' }
  Add-Log "Lilin Setup, $(Get-Date -Format 'yyyy-MM-dd HH:mm'), $($S.Info.appDir)"
  Update-Buttons
  Next-Step
}

function Finish-Run {
  $S.Busy = $false
  $U.ProgressBar.Value = 100
  $S.Url = Lilin-Url
  Show-Page (Page-Index 'PDone')
  if ($TestRun) { End-TestRun 0 }
}
function End-TestRun([int]$code) {
  [Console]::Out.WriteLine($S.Log.ToString())
  [Console]::Out.WriteLine(("STEPS: " + (($Run.Steps | ForEach-Object { "$($_.Id)=$($_.Status)" }) -join ' ')))
  [Console]::Out.WriteLine(("TODO: " + (($S.Todo | Select-Object -Unique) -join ' | ')))
  [Console]::Out.WriteLine("URL: $($S.Url)  RUNNING: $($S.Running)")
  $script:TestExit = $code
  $Win.Close()
}

function Fill-Done {
  $U.DoneUrl.Text = $S.Url
  $U.DoneUrlHint.Text = if ($U.HostLocal.IsChecked) { 'Only this PC can open it (your tunnel or proxy publishes it).' } else { 'From any phone, TV or computer at home. Bookmark it, or add it to your phone''s home screen.' }
  $U.StartBtn.Visibility = Vis (-not $S.Running -and -not $U.AutoOn.IsChecked -and -not $S.Info.autostart)
  $warned = @($Run.Steps | Where-Object { $_.Status -eq 'warn' }).Count
  $U.PageLead.Text = if ($warned) { 'Almost: a step needs a hand, see below.' } elseif ($S.Running) { 'It''s running. Here''s how to open it.' } else { 'Start it below, then open it in a browser.' }
  $U.RemoteBox.Visibility = 'Collapsed'
  if ($U.ClipsOn.IsChecked -and $S.ClipPlan -and $S.ClipPlan.remoteCommand) {
    $U.RemoteBox.Visibility = 'Visible'
    $shell = if ($S.ClipPlan.where -eq 'windows') { 'PowerShell' } else { 'a terminal' }
    $U.RemoteLead.Text = "Run this in $shell on the PC you play on. It downloads the same reviewed Clipper version, checks it and installs it, sending clips to $($S.ClipPlan.share)." +
      $(if ($S.ClipPlan.where -eq 'windows') { " If the share needs a login, save it there first: cmdkey /add:$env:COMPUTERNAME /user:$env:COMPUTERNAME\$env:USERNAME /pass" } else { '' })
    $U.RemoteCmd.Text = $S.ClipPlan.remoteCommand
    if (-not $U.ShareMake.IsChecked) { foreach ($l in @($S.ClipPlan.shareLines)) { if ($l -match 'New-SmbShare') { [void]$S.Todo.Add("Share the clips folder (elevated PowerShell): $($l.Trim())") } } }
  }
  $owner = $U.OwnerEmail.Text.Trim().ToLower()
  if ($owner -and -not $U.OwnerPw.Password -and -not ($S.Info.logins -contains $owner) -and ((Selected-Remote) -ne 'cloudflare' -or (Oidc-On))) {
    [void]$S.Todo.Add("Give $owner a password so you can sign in: run Lilin Setup again (Sign-in page)")
  }
  if ((Selected-Remote) -eq 'cloudflare') { [void]$S.Todo.Add('Finish Cloudflare Tunnel and Access: docs\remote-access.md in the Lilin folder') }
  if ((Selected-Remote) -eq 'tailscale') { [void]$S.Todo.Add("Install Tailscale on this PC and your devices, then open http://$($env:COMPUTERNAME.ToLower()):$($U.Port.Text.Trim())") }
  if ((Selected-Remote) -eq 'proxy') { [void]$S.Todo.Add('Point your reverse proxy at this PC: docs\remote-access.md in the Lilin folder') }
  $U.OidcBox.Visibility = 'Collapsed'
  if ((Oidc-On) -and -not $Screenshot) {
    Wizard-Json 'oidc' $null {
      param($m, $err)
      if ($m -and $m.ready) { $U.OidcText.Text = (@($m.lines) -join "`r`n"); $U.OidcBox.Visibility = 'Visible' }
      elseif ($m) { [void]$U.TodoList.Children.Add((Bullet-Row (Glyph dot) $B.Bulb "Lilin sign-in for Access is missing $(@($m.missing) -join ', '): run Lilin Setup again")); $U.TodoBox.Visibility = 'Visible' }
    }
  }
  $U.TodoList.Children.Clear()
  foreach ($t in ($S.Todo | Select-Object -Unique)) { [void]$U.TodoList.Children.Add((Bullet-Row (Glyph dot) $B.Bulb $t)) }
  $U.TodoBox.Visibility = Vis ($S.Todo.Count -gt 0)
}

# ---------------------------------------------------------------- new installs: Node.js + download
function Install-First {
  $S.Busy = $true; Update-Buttons
  $U.InstallProgress.Visibility = 'Visible'; $U.InstallBar.IsIndeterminate = $true
  $U.InstallDir.IsEnabled = $false; $U.InstallDirBtn.IsEnabled = $false
  Fill-NodeState
  if (-not ($S.Node -and $S.Node.Ok)) { Install-Node { Install-Release } } else { Install-Release }
}
function Install-Failed([string]$msg) {
  $S.Busy = $false
  $U.InstallBar.IsIndeterminate = $false; $U.InstallBar.Value = 0
  $U.InstallProgressText.Text = $msg; $U.InstallProgressText.Foreground = $B.Alert
  $U.InstallDir.IsEnabled = $true; $U.InstallDirBtn.IsEnabled = $true
  Update-Buttons
}
function Install-Node([scriptblock]$then) {
  $wg = Find-Winget
  if (-not $wg) { Open-Url 'https://nodejs.org/en/download'; Install-Failed 'Install Node.js LTS from nodejs.org (it just opened), then press Install again.'; return }
  $U.InstallProgressText.Text = 'Installing Node.js LTS...'; $U.InstallProgressText.Foreground = $B.Paper
  Start-Proc -File $wg -Arguments @('install', '--id', 'OpenJS.NodeJS.LTS', '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity') `
    -Ctx @{ Next = $then } -OnLine { param($l) if ($l.Trim()) { $U.InstallProgressLine.Text = $l.Trim(); Add-Log $l } } -OnExit {
      param($code, $out, $err, $ctx)
      Fill-NodeState
      if ($S.Node -and $S.Node.Ok) { & $ctx.Next } else { Install-Failed "Node.js didn't install (winget exit code $code). Install it from nodejs.org, then press Install." }
    }
}
function Get-LatestRelease {
  # Tag of the newest GitHub release (e.g. v1.3.0), or $null when offline / rate-limited.
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $req = [Net.HttpWebRequest]::Create('https://api.github.com/repos/Tjabooo/lilin/releases/latest')
    $req.UserAgent = 'LilinSetup'; $req.Accept = 'application/vnd.github+json'; $req.Timeout = 10000
    $res = $req.GetResponse()
    try { $body = (New-Object IO.StreamReader $res.GetResponseStream()).ReadToEnd() } finally { $res.Close() }
    $t = ($body | ConvertFrom-Json).tag_name
    if ($t -match '^v\d+\.\d+\.\d+') { return $t }
  } catch { Add-Log "Couldn't look up the latest release: $($_.Exception.Message)" }
  return $null
}
function Install-Release {
  $dir = [IO.Path]::GetFullPath($U.InstallDir.Text.Trim())
  if ($S.SkipDownload -or (Test-Path (Join-Path $dir '.git'))) { Load-App $dir; return }
  # Always the newest release (unless -Version pins one), even from an older LilinSetup.exe:
  # look it up now, and use that release's install.ps1. Offline lookups fall back to the bundled one.
  $tag = if ($Version) { $Version } else { Get-LatestRelease }
  if (-not $tag) { $tag = $BundledVersion }
  $inst = if ($InstallScript -and (Test-Path $InstallScript) -and (-not $tag -or $tag -eq $BundledVersion)) { $InstallScript } else { $null }
  if (-not $inst) {
    $inst = Join-Path ([IO.Path]::GetTempPath()) ("lilin-install-" + [guid]::NewGuid().ToString('N') + '.ps1')
    $ref = if ($tag) { $tag } else { 'master' }
    try { (New-Object Net.WebClient).DownloadFile("https://raw.githubusercontent.com/Tjabooo/lilin/$ref/install.ps1", $inst); [void]$S.TempFiles.Add($inst) }
    catch {
      if ($InstallScript -and (Test-Path $InstallScript)) { $inst = $InstallScript }
      else { Install-Failed "Couldn't download the installer: $($_.Exception.Message)"; return }
    }
  }
  $U.InstallProgressText.Text = "Downloading Lilin $(if ($tag) { $tag } else { '(latest release)' })..."; $U.InstallProgressText.Foreground = $B.Paper
  $iargs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $inst, '-Dir', $dir, '-NoSetup')
  if ($tag) { $iargs += @('-Version', $tag) }
  Start-Proc -File 'powershell.exe' -Arguments $iargs -Ctx @{ Dir = $dir } -OnLine { param($l) if ($l.Trim()) { $U.InstallProgressLine.Text = $l.Trim(); Add-Log $l } } -OnExit {
    param($code, $out, $err, $ctx)
    if ($code -ne 0 -or -not (Test-Path (Join-Path $ctx.Dir 'setup.js'))) {
      $why = @(($err.Trim() -split "`r?`n") | Where-Object { $_ -and $_ -notmatch '^\s*(At |\+|CategoryInfo|FullyQualifiedErrorId)' }) | Select-Object -First 1
      if (-not $why) { $why = @($out.Trim() -split "`r?`n") | Select-Object -Last 1 }
      Install-Failed "Installing failed: $why"; return
    }
    Load-App $ctx.Dir
  }
}
function Load-App([string]$dir) {
  $U.InstallProgressText.Text = 'Reading this PC''s setup...'
  $script:AppDir = $dir
  $S.Info = @{ appDir = $dir }   # so Start-Proc runs in it
  Wizard-Json 'info' $null {
    param($info, $err)
    if (-not $info) { Install-Failed "Setup couldn't read the installation: $err"; return }
    $S.Info = $info; $S.InstallDone = $true
    Fill-FromInfo
    $U.InstallBar.IsIndeterminate = $false; $U.InstallBar.Value = 100
    $U.InstallProgressText.Text = "$(Glyph ok)  Lilin $($info.version) is installed in $($info.appDir)"
    $U.InstallProgressLine.Text = ''
    $S.Busy = $false
    Show-Page ($S.Page + 1)
  } $dir
}

# ---------------------------------------------------------------- navigation
function Update-Buttons {
  $key = $Pages[$S.Page].Key
  $U.BackBtn.Visibility = Vis ($S.Page -gt 0 -and $key -ne 'PDone' -and ($key -ne 'PProgress' -or $Run.Failed))
  $U.BackBtn.IsEnabled = -not $S.Busy
  $U.NextBtn.IsEnabled = -not $S.Busy
  $U.CancelBtn.IsEnabled = -not $S.Busy
  $U.CancelBtn.Visibility = Vis ($key -ne 'PDone')
  $U.CancelBtn.Content = if ($key -eq 'PProgress' -and $Run.Failed) { 'Close' } else { 'Cancel' }
  $U.NextBtn.Content = switch ($key) {
    'PWelcome' { if ($Fresh) { 'Get started' } else { 'Next' } }
    'PInstall' { if ($S.InstallDone) { 'Next' } else { 'Install' } }
    'PReview' { if ($Fresh -or -not $S.Info.envExists) { 'Install' } else { 'Apply' } }
    'PProgress' { if ($Run.Failed) { 'Try again' } else { 'Working...' } }
    'PDone' { 'Finish' }
    default { 'Next' }
  }
}
function Show-Page([int]$i) {
  foreach ($p in $Pages) { $U[$p.Key].Visibility = 'Collapsed' }
  $S.Page = $i
  $key = $Pages[$i].Key
  $U[$key].Visibility = 'Visible'
  $U.PageTitle.Text = $Titles[$key][0]; $U.PageLead.Text = $Titles[$key][1]
  switch ($key) {
    'PWelcome' { Fill-Welcome }
    'PInstall' { Fill-NodeState; Fill-InstallDirHint }
    'PNetwork' { Check-Port }
    'PClips' { Refresh-ClipPlan }
    'PReview' { Fill-Review }
    'PDone' { Fill-Done }
  }
  if ($key -eq 'PWelcome' -and -not $Fresh -and $S.Info) { $U.PageTitle.Text = 'Lilin Setup' }
  if ($key -eq 'PDone' -and -not $Fresh) { $U.PageTitle.Text = $(if ($S.Info.envExists) { 'Changes saved' } else { 'Lilin is ready' }) }
  $U.PageLead.Visibility = Vis ([bool]$U.PageLead.Text)
  $U.Scroll.ScrollToTop()
  Set-Foot ''
  Update-Sidebar; Update-Buttons
}
function Go-Next {
  if ($S.Busy) { return }
  $key = $Pages[$S.Page].Key
  if ($key -eq 'PDone') { $Win.Close(); return }
  if ($key -eq 'PProgress' -and $Run.Failed) { Show-Page (Page-Index 'PProgress'); Start-Run; return }
  if (-not (Validate-Page $key)) { return }
  if ($key -eq 'PInstall' -and -not $S.InstallDone) { Install-First; return }
  if ($key -eq 'PReview') { Show-Page (Page-Index 'PProgress'); Start-Run; return }
  $n = $S.Page + 1
  while ($n -lt $Pages.Count -and (Page-Skipped $n)) { $n++ }
  Show-Page $n
}
function Go-Back {
  if ($S.Busy) { return }
  $key = $Pages[$S.Page].Key
  if ($key -eq 'PProgress') { Show-Page (Page-Index 'PReview'); return }
  $n = $S.Page - 1
  while ($n -gt 0 -and (Page-Skipped $n)) { $n-- }
  Show-Page ([math]::Max(0, $n))
}

# Live port check on the Network page.
function Check-Port {
  if (-not $S.Info -or -not $S.Info.version) { return }
  $p = $U.Port.Text.Trim()
  $U.PortState.Text = 'checking...'; $U.PortState.Foreground = $B.Dust; $U.PortState.Tag = $null
  Wizard-Json 'check' @{ PORT = $p; only = @() } -Ctx @{ Port = $p } -OnDone {
    param($r, $err, $ctx)
    if ($U.Port.Text.Trim() -ne $ctx.Port) { return }
    if (-not $r) { $U.PortState.Text = ''; return }
    $U.PortState.Text = $(if ($r.port.ok) { "$(Glyph ok)  " } else { '' }) + $r.port.detail
    $U.PortState.Foreground = if ($r.port.ok) { $B.Good } else { $B.Alert }
    $U.PortState.Tag = if ($r.port.ok) { 'ok' } elseif ($r.port.detail -match 'used') { 'busy' } else { 'bad' }
  }
}
function Test-Services {
  $a = @{ only = @('tmdb', 'qbit', 'opensubtitles') }
  if ($U.Tmdb.Password) { $a.TMDB_TOKEN = $U.Tmdb.Password.Trim() }
  if ($U.OpenSubs.Password) { $a.OPENSUBTITLES_API_KEY = $U.OpenSubs.Password.Trim() }
  if ($U.QbitOn.IsChecked) { $a.QBIT_URL = $U.QbitUrl.Text.Trim(); $a.QBIT_USER = $U.QbitUser.Text.Trim(); if ($U.QbitPass.Password) { $a.QBIT_PASS = $U.QbitPass.Password } } else { $a.QBIT_URL = '' }
  $U.TestBtn.IsEnabled = $false; $U.TestState.Text = 'testing...'; $U.TestState.Foreground = $B.Dust
  Wizard-Json 'check' $a {
    param($r, $err)
    $U.TestBtn.IsEnabled = $true
    if (-not $r) { $U.TestState.Text = "Couldn't test: $err"; return }
    $U.TestState.Text = ''
    foreach ($pair in @(@('tmdb', 'TmdbState', 'Tmdb'), @('opensubtitles', 'OsState', 'OpenSubs'), @('qbit', 'QbitState', 'QbitPass'))) {
      $res = $r.($pair[0]); $t = $U[$pair[1]]
      if ($res) { $t.Text = $(if ($res.ok) { "$(Glyph ok)  " } else { "$(Glyph err)  " }) + $res.detail; $t.Foreground = if ($res.ok) { $B.Good } else { $B.Alert } }
      elseif ($pair[0] -ne 'qbit' -or $U.QbitOn.IsChecked) { $t.Text = 'Not set: skipped'; $t.Foreground = $B.Dust }
    }
    $bad = @('tmdb', 'opensubtitles', 'qbit' | Where-Object { $r.$_ -and -not $r.$_.ok }).Count
    $U.TestState.Text = if ($bad) { "$bad problem(s): see above" } else { "$(Glyph ok)  All good" }
    $U.TestState.Foreground = if ($bad) { $B.Alert } else { $B.Good }
  }
}

function Pick-Folder($box, [string]$title) {
  $h = (New-Object Windows.Interop.WindowInteropHelper $Win).Handle
  $start = $box.Text.Trim()
  while ($start -and -not (Test-Path $start)) { $start = Split-Path $start -Parent }
  $p = [LilinNative]::PickFolder($h, $title, $start)
  if ($p) { $box.Text = $p }
}

# ---------------------------------------------------------------- events
$U.NextBtn.add_Click({ Go-Next })
$U.BackBtn.add_Click({ Go-Back })
$U.CancelBtn.add_Click({ $Win.Close() })
$U.NodeBtn.add_Click({ Open-Url 'https://nodejs.org/en/download' })
$U.InstallDirBtn.add_Click({ Pick-Folder $U.InstallDir 'Where to install Lilin'; Fill-InstallDirHint })
$U.InstallDir.add_TextChanged({ Fill-InstallDirHint })
$U.MediaDirBtn.add_Click({ Pick-Folder $U.MediaDir 'Folder with your films and shows' })
$U.DataDirBtn.add_Click({ Pick-Folder $U.DataDir 'Folder for Lilin''s database' })
$U.CacheDirBtn.add_Click({ Pick-Folder $U.CacheDir 'Folder for Lilin''s cache' })
$U.ClipsDirBtn.add_Click({ Pick-Folder $U.ClipsDir 'Folder for game clips'; Refresh-ClipPlan })
$U.MediaDir.add_LostFocus({ if ($S.Info -and -not $S.Info.values.CLIPS_DIR -and $U.MediaDir.Text.Trim()) { try { $U.ClipsDir.Text = Join-Path (Split-Path ([IO.Path]::GetFullPath($U.MediaDir.Text.Trim())) -Parent) 'Clips' } catch { } } })
$U.Port.add_LostFocus({ Check-Port })
$U.TestBtn.add_Click({ Test-Services })
foreach ($n in 'RemoteNone', 'RemoteTailscale', 'RemoteCloudflare', 'RemoteProxy', 'WhereHere', 'WhereWindows', 'WhereLinux', 'WhereNone') {
  $U[$n].add_Checked({ Update-Visibility; if ($Pages[$S.Page].Key -eq 'PClips') { Refresh-ClipPlan } })
}
foreach ($n in 'QbitOn', 'ClipsOn', 'AutoOn', 'OidcOn') { $U[$n].add_Checked({ Update-Visibility; if ($Pages[$S.Page].Key -eq 'PClips') { Refresh-ClipPlan } }); $U[$n].add_Unchecked({ Update-Visibility }) }
$U.CfTeam.add_TextChanged({ Update-Visibility })
$U.OwnerEmail.add_LostFocus({ Update-Visibility })
$U.Quality.add_SelectionChanged({ Update-Visibility; if ($Pages[$S.Page].Key -eq 'PClips') { Refresh-ClipPlan } })
$U.ClipsDir.add_LostFocus({ Refresh-ClipPlan })
$U.SharePath.add_KeyDown({ $U.SharePath.Tag = 'typed' })
$U.SharePath.add_LostFocus({ Refresh-ClipPlan })
$U.WinPw.add_PasswordChanged({ $U.WinPwState.Text = ''; $S.NextConfirmed = $null })
foreach ($n in 'TmdbLink', 'OsLink', 'ClipLink') { $U[$n].add_RequestNavigate({ param($st, $e) Open-Url $e.Uri.AbsoluteUri }) }
$U.OpenBtn.add_Click({ Open-Url $S.Url })
$U.StartBtn.add_Click({
  $cmd = Join-Path $S.Info.appDir 'start-lilin.cmd'
  Start-Process cmd.exe -ArgumentList '/c', "`"$cmd`"" -WorkingDirectory $S.Info.appDir -WindowStyle Hidden
  $U.StartBtn.IsEnabled = $false; $U.StartBtn.Content = 'Starting...'
  Wait-Lilin 30 {
    param($ok)
    if ($ok) { $U.StartBtn.Content = "$(Glyph ok)  Running"; $U.PageLead.Text = 'It''s running. Here''s how to open it.' }
    else { $U.StartBtn.Content = 'Start Lilin'; $U.StartBtn.IsEnabled = $true; Set-Foot "It didn't answer: see $($S.Info.appDir)\logs\lilin.log" }
  }
})
$U.CopyBtn.add_Click({ [Windows.Clipboard]::SetText($U.RemoteCmd.Text); $U.CopyBtn.Content = "$(Glyph ok)  Copied" })
$U.OidcCopy.add_Click({ [Windows.Clipboard]::SetText($U.OidcText.Text); $U.OidcCopy.Content = "$(Glyph ok)  Copied" })
$U.LogBtn.add_Click({
  $f = Join-Path ([IO.Path]::GetTempPath()) 'lilin-setup.log'
  [IO.File]::WriteAllText($f, $S.Log.ToString(), (New-Object Text.UTF8Encoding $false))
  Start-Process notepad.exe $f
})
# A bug in a button handler shouldn't close the window: show it and carry on.
$Win.Dispatcher.add_UnhandledException({
  param($sender, $e)
  $e.Handled = $true
  $msg = $e.Exception.Message
  Add-Log "Error: $msg"
  if ($Pages[$S.Page].Key -eq 'PProgress' -and $S.Busy) { Fail-Step $msg } else { $S.Busy = $false; Update-Buttons; Set-Foot "Something went wrong: $msg" }
})
# Fit small screens (the window is 980 x 700 where there's room).
$wa = [Windows.SystemParameters]::WorkArea
if ($wa.Width -lt $Win.Width + 20) { $Win.Width = [math]::Max($Win.MinWidth, $wa.Width - 20) }
if ($wa.Height -lt $Win.Height + 20) { $Win.Height = [math]::Max($Win.MinHeight, $wa.Height - 20) }
# Lilin's icon in the title bar and taskbar, from the launcher exe or the installation.
try {
  $png = if ($AppDir) { Join-Path $AppDir 'public\icon-192.png' } else { $null }
  if ($png -and (Test-Path $png)) { $Win.Icon = [Windows.Media.Imaging.BitmapFrame]::Create([uri]$png) }
  elseif ($LauncherPath -and (Test-Path $LauncherPath)) {
    Add-Type -AssemblyName System.Drawing
    $ico = [Drawing.Icon]::ExtractAssociatedIcon($LauncherPath)
    $Win.Icon = [Windows.Interop.Imaging]::CreateBitmapSourceFromHIcon($ico.Handle, [Windows.Int32Rect]::Empty, [Windows.Media.Imaging.BitmapSizeOptions]::FromEmptyOptions())
  }
} catch { }
$Win.add_SourceInitialized({
  try { [LilinNative]::DarkTitle((New-Object Windows.Interop.WindowInteropHelper $Win).Handle, 0x19101F) } catch { }
})
$Win.add_Closing({
  param($st, $e)
  if ($S.Busy -and $Pages[$S.Page].Key -eq 'PProgress') {
    $r = [Windows.MessageBox]::Show($Win, 'Setup is still working. Stop it anyway? A half-finished step can be repeated by running Setup again.', 'Lilin Setup', 'YesNo', 'Warning')
    if ($r -ne 'Yes') { $e.Cancel = $true; return }
  }
  foreach ($j in @($Jobs)) { try { if (-not $j.P.HasExited) { $j.P.Kill() } } catch { } }
  foreach ($f in @($S.TempFiles)) { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }
  $Timer.Stop()
})

# ---------------------------------------------------------------- start
$U.InstallDir.Text = $DefaultDir
Build-Sidebar
$S.Node = Find-Node

function Start-Configure {
  # An existing installation: read it, then show the welcome page.
  if (-not ($S.Node -and $S.Node.Ok)) {
    $script:Fresh = $true     # no usable Node: the Install page installs it, then reads this folder
    $S.SkipDownload = $true
    $U.InstallDir.Text = $AppDir; $U.InstallDir.IsEnabled = $false; $U.InstallDirBtn.IsEnabled = $false
    Build-Sidebar
    Show-Page 0
    return
  }
  $S.Info = @{ appDir = $AppDir }
  $S.Busy = $true
  Show-Page 0
  $U.WelcomeState.Text = 'Reading this PC''s setup...'
  Wizard-Json 'info' $null {
    param($info, $err)
    $S.Busy = $false
    if (-not $info) { $U.WelcomeState.Text = "Setup couldn't read $AppDir"; $U.WelcomeStateHint.Text = $err; Update-Buttons; $U.NextBtn.IsEnabled = $false; return }
    $S.Info = $info; $S.InstallDone = $true
    Fill-FromInfo
    Show-Page 0
  } $AppDir
}

if ($SelfTest -or $Screenshot) {
  # Fill every page with a sample state, check that the named parts exist, optionally render PNGs.
  $missing = @($U.Keys | Where-Object { $null -eq $U[$_] })
  if ($missing) { Write-Output "Missing elements: $($missing -join ', ')"; exit 1 }
  $S.Node = [pscustomobject]@{ Path = 'node.exe'; Version = [version]'22.22.0'; Ok = $true }
  $sample = '{"version":"1.1.0","appDir":"C:\\Users\\you\\lilin","envFile":"C:\\Users\\you\\lilin\\.env","envExists":false,"freshInstall":true,"lan":["192.168.1.20"],
    "values":{},"secrets":{"TMDB_TOKEN":true},"defaults":{"MEDIA_DIR":"D:\\Media","DATA_DIR":"","PORT":"8080","HOST":"0.0.0.0","HOME_NETWORK_ACCESS":"shared","remoteAccess":"none","CLIPS_DIR":"D:\\Clips"},
    "running":null,"portFree":true,"ffmpeg":null,"winget":true,"logins":[],"ownerHasLogin":false,"autostart":false,
    "clipper":{"commit":"30cd2d10cf18a9bac18d5439512407eb276273d9","source":"https://github.com/Tjabooo/clipper","installs":{},"installedHere":false,
    "quality":[{"value":"balanced","label":"balanced: 60 fps, quality-based bitrate (default)"},{"value":"high","label":"high: 60 fps, 60 Mbit/s at 1440p, sharp in fast motion"},{"value":"bench:quality","label":"benchmark for quality: measure the PC, pick the lowest bitrate that looks lossless"}]}}'
  $S.Info = $sample | ConvertFrom-Json
  $script:Fresh = $true; Build-Sidebar
  Fill-FromInfo
  $U.ClipsOn.IsChecked = $true; Update-Visibility
  $r = Bullet-Row (Glyph dot) $B.Dust 'OBS Studio, and the .NET 8 SDK to build Clipper (with winget)'; [void]$U.ClipInstalls.Children.Add($r)
  if (-not $Screenshot) { Write-Output 'Self-test passed'; exit 0 }
  New-Item -ItemType Directory -Force $Screenshot | Out-Null
  $Win.Width = 980; $Win.Height = 700
  $Win.WindowStyle = 'None'; $Win.ShowInTaskbar = $false; $Win.Left = -20000; $Win.Top = -20000; $Win.ShowActivated = $false
  $Win.Show()
  $render = {
    param([string]$name)
    $Win.UpdateLayout()
    $Win.Dispatcher.Invoke([Action] {}, 'Render')
    $bmp = New-Object Windows.Media.Imaging.RenderTargetBitmap ([int]$Win.ActualWidth), ([int]$Win.ActualHeight), 96, 96, ([Windows.Media.PixelFormats]::Pbgra32)
    $bmp.Render($Win.Content)
    $enc = New-Object Windows.Media.Imaging.PngBitmapEncoder
    $enc.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bmp))
    $fs = [IO.File]::Create((Join-Path $Screenshot "$name.png")); $enc.Save($fs); $fs.Close()
  }
  $Timer.Stop()
  for ($i = 0; $i -lt $Pages.Count; $i++) {
    $key = $Pages[$i].Key
    if ($key -eq 'PProgress') {
      Show-Page $i; Build-Plan
      foreach ($st in $Run.Steps) { $row = Bullet-Row (Glyph dot) $B.Line $st.Label; $Run.Rows[$st.Id] = $row; [void]$U.ProgressList.Children.Add($row); Set-Row $st 'wait' }
      Set-Row $Run.Steps[0] 'ok'; Set-Row $Run.Steps[1] 'run'; $U.ProgressBar.Value = 35
      Add-Log 'Lilin setup'; Add-Log "$([char]0x2713) Windows (10.0.26100) x64, Node.js 22.22.0"; Add-Log 'Creating C:\Users\you\lilin\.env:'
    } elseif ($key -eq 'PDone') {
      $S.Url = 'http://192.168.1.20:8080'; $S.Running = $true
      $S.ClipPlan = [pscustomobject]@{ where = 'windows'; share = '\\GAMEBOX\Clips'; remoteCommand = '$f = "$env:TEMP\clipper-install.ps1"; irm https://raw.githubusercontent.com/Tjabooo/clipper/30cd2d1/install.ps1 -OutFile $f; ...'; shareLines = @() }
      $U.WhereWindows.IsChecked = $true; $U.ShareMake.IsChecked = $true
      [void]$S.Todo.Add('Finish Cloudflare Tunnel and Access: docs\remote-access.md')
      Show-Page $i
      $U.OidcText.Text = "Cloudflare Zero Trust, Settings, Authentication, Login methods, Add new, OpenID Connect:`r`n  App ID:           cloudflare`r`n  Client secret:    (sample)`r`n  Auth URL:         https://lilin.example.com/c/oidc/authorize"
      $U.OidcBox.Visibility = 'Visible'
    } else { Show-Page $i }
    if ($key -eq 'PInstall') { $U.NodeState.Text = 'Node.js is not installed'; $U.NodeState.Foreground = $B.Bulb; $U.NodeHint.Text = 'Lilin needs Node.js 22.16 or later. Setup installs the current LTS for you (with winget) when you press Install.'; $U.NodeBtn.Visibility = 'Collapsed' }
    if ($key -eq 'PNetwork') { $U.PortState.Text = "$(Glyph ok)  free"; $U.PortState.Foreground = $B.Good }
    & $render ("{0:D2}-{1}" -f $i, $key.Substring(1).ToLower())
  }
  $Win.Close()
  Write-Output "Rendered $($Pages.Count) pages to $Screenshot"
  exit 0
}

if ($TestRun) {
  # Fill the pages from a JSON file of values, then run the plan in a hidden window.
  $T = Get-Content -LiteralPath $TestRun -Raw | ConvertFrom-Json
  $script:TestExit = 2
  $Win.WindowStyle = 'None'; $Win.ShowInTaskbar = $false; $Win.Left = -20000; $Win.Top = -20000; $Win.ShowActivated = $false
  Wait-For -Until { param($c) $S.Info -and $S.Info.version -and -not $S.Busy } -Then {
    foreach ($p in $T.PSObject.Properties) {
      $c = $U[$p.Name]
      if ($c -is [Windows.Controls.PasswordBox]) { $c.Password = [string]$p.Value }
      elseif ($c -is [Windows.Controls.Primitives.ToggleButton]) { $c.IsChecked = [bool]$p.Value }
      elseif ($c -is [Windows.Controls.ComboBox]) { $c.SelectedIndex = [int]$p.Value }
      elseif ($c) { $c.Text = [string]$p.Value }
    }
    Update-Visibility
    foreach ($k in 'PLibrary', 'PNetwork', 'PAccess', 'PServices', 'PClips') { if (-not (Validate-Page $k)) { [Console]::Out.WriteLine("Invalid $($k): $($U.FootMsg.Text)"); $script:TestExit = 3; $Win.Close(); return } }
    Show-Page (Page-Index 'PProgress'); Start-Run
  }
  Start-Configure
  [void]$Win.ShowDialog()
  exit $TestExit
}
if ($Fresh) { Show-Page 0 } else { Start-Configure }
[void]$Win.ShowDialog()
