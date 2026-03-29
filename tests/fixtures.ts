/**
 * Shared test fixtures — realistic Symphony log data for unit tests.
 */

// ── A single well-formed IS Error log line ──
export const IS_ERROR_LINE =
  '10:34:21.123    1234 <Error   > WebService\tRequestProcessor.ProcessRequest[14985156 ae.exe]\tSystem.TimeoutException: The request timed out.';

// ── A BasicInfo log line ──
export const IS_BASIC_INFO_LINE =
  '10:34:22.456    5678 <BasicInf> Communication\tCommunicationManager.Connect\tConnecting to 10.60.31.4:8398';

// ── A verbose log line (sub-diagnostic) ──
export const VERBOSE_LINE =
  '10:34:23.789    9999 <Tracker > Tracker.Update\tCamera 5 frame processed';

// ── Multi-line error with stack trace ──
export const ERROR_WITH_STACK = [
  '10:35:00.000    1234 <Error   > WebService\tHandler.Execute\tSystem.NullReferenceException: Object reference not set',
  '   at Seer.Web.Handler.Execute() in C:\\src\\Handler.cs:line 42',
  '   at Seer.Web.Pipeline.Run() in C:\\src\\Pipeline.cs:line 18',
].join('\n');

// ── IS log content (multi-entry) ──
export const IS_LOG_CONTENT = [
  '10:00:00.000       1 <BasicInf> Service\tInfoService.OnStart\tService starting',
  '10:00:01.000       1 <MoreInfo> Service\tInfoService.OnStart\tLoading configuration',
  '10:00:05.000    1234 <BasicInf> WebService\tRequestLogger[AE]\tGET /api/cameras took 00:00:00.0450000 status=200 client=10.60.31.10:51234',
  '10:00:06.000    1234 <Error   > WebService\tRequestLogger[AE]\tGET /api/alarms took 00:00:05.1230000 status=500 client=10.60.31.10:51234',
  '   at Seer.Alarms.AlarmProvider.GetAlarms() in C:\\src\\AlarmProvider.cs:line 99',
  '10:00:07.000    1234 <BasicInf> WebService\tRequestLogger[AE]\tPOST /api/ptz took 00:00:00.0120000 status=200 client=10.60.31.10:51234',
  '10:00:08.000    5678 <Error   > Communication\tRpcClient.Send[CallRPC]\tSystem.TimeoutException: The operation timed out. Target=10.60.32.1:8398',
  '10:00:09.000    5678 <Error   > Communication\tRpcClient.Send[CallRPC]\tSystem.TimeoutException: The operation timed out. Target=10.60.32.1:8398',
].join('\n');

// ── SCCP log content (CPU/memory stats) ──
export const SCCP_LOG_CONTENT = [
  '10:00:00.000       1 <BasicInf> CpuCounter\tCpuCounter.Report\tinfoservice.exe\tPID=1234 CPU=12.3% Mem=245,123K',
  '10:00:00.000       1 <BasicInf> CpuCounter\tCpuCounter.Report\tscheduler.exe\tPID=5678 CPU=5.1% Mem=112,456K',
  '10:00:00.000       1 <BasicInf> CpuCounter\tCpuCounter.Report\tTracker(1)\tPID=9012 CPU=25.0% Mem=523,000K',
  '10:00:00.000       1 <BasicInf> CpuCounter\tCpuCounter.Report\tae.exe\tPID=3456 CPU=3.2% Mem=198,000K',
  '10:00:00.000       1 <BasicInf> CpuCounter\tCpuCounter.Report\tchrome.exe\tPID=7890 CPU=8.5% Mem=345,000K',
  '10:05:00.000       1 <BasicInf> CpuCounter\tCpuCounter.Report\tinfoservice.exe\tPID=1234 CPU=15.5% Mem=255,000K',
  '10:05:00.000       1 <BasicInf> CpuCounter\tCpuCounter.Report\tscheduler.exe\tPID=5678 CPU=6.0% Mem=115,000K',
  '10:05:00.000       1 <BasicInf> CpuCounter\tCpuCounter.Report\tTracker(1)\tPID=9012 CPU=28.0% Mem=530,000K',
].join('\n');

// ── HTTP request log lines ──
export const HTTP_LOG_LINES = [
  '10:00:05.000    1234 <BasicInf> WebService\tRequestLogger[AE]\tGET /api/cameras took 00:00:00.0450000 status=200 client=10.60.31.10:51234',
  '10:00:06.000    1234 <BasicInf> WebService\tRequestLogger[AE]\tGET /api/alarms took 00:00:05.1230000 status=500 client=10.60.31.10:51234',
  '10:00:07.000    1234 <BasicInf> WebService\tRequestLogger[AE]\tPOST /api/ptz took 00:00:00.0120000 status=200 client=10.60.31.10:51234',
  '10:00:10.000    1234 <BasicInf> WebService\tRequestLogger[AE]\tGET /api/cameras took 00:00:00.0380000 status=200 client=10.60.31.11:52000',
].join('\n');

// ── Midnight rollover lines ──
export const MIDNIGHT_ROLLOVER_LINES = [
  '23:59:58.000       1 <BasicInf> Service\tHeartbeat\tAlive',
  '23:59:59.500       1 <BasicInf> Service\tHeartbeat\tAlive',
  '00:00:00.100       1 <BasicInf> Service\tHeartbeat\tAlive',
  '00:00:01.000       1 <BasicInf> Service\tHeartbeat\tAlive',
];

// ── serverinfo.txt for config-parser tests ──
export const SERVER_INFO_TXT = `--- Server Info (SERVER1) ---
IP: 10.60.31.4 (This Server) (Master)
OS Version: Microsoft Windows Server 2019 Standard
OS Build: 17763
CPU: Intel Xeon E-2286G @ 4.00GHz
Cores: 6
Logical Processors: 12
Total RAM: 32.0
Available RAM: 18.5
Product Version: 7.3.2.1
Service Account: LocalSystem
Install Path: C:\\Program Files\\Senstar\\Symphony
Database Server: SERVER1\\SQLEXPRESS

C: (System)  Total: 237.9 GB  Free: 112.3 GB (53%)
D: (Storage) Total: 1863.0 GB  Free: 891.2 GB (52%)

--- Server Info (SERVER2) ---
IP: 10.60.31.5
OS Version: Microsoft Windows Server 2019 Standard
OS Build: 17763
CPU: Intel Xeon E-2286G @ 4.00GHz
Cores: 6
Logical Processors: 12
Total RAM: 32.0
Available RAM: 24.1
Product Version: 7.3.2.1
Service Account: LocalSystem
Install Path: C:\\Program Files\\Senstar\\Symphony
Database Server: SERVER1\\SQLEXPRESS

C: (System)  Total: 237.9 GB  Free: 180.1 GB (24%)
D: (Storage) Total: 1863.0 GB  Free: 1200.5 GB (36%)
`;

// ── services.txt for system-info-parser tests ──
export const SERVICES_TXT = `SERVICE_NAME: SenstarSymphonyInfoService
        DISPLAY_NAME: Senstar Symphony Information Service
        TYPE               : 10  WIN32_OWN_PROCESS
        STATE              : 4  RUNNING
        PID                : 1234

SERVICE_NAME: SenstarSymphonyScheduler
        DISPLAY_NAME: Senstar Symphony Scheduler  
        TYPE               : 10  WIN32_OWN_PROCESS
        STATE              : 4  RUNNING
        PID                : 5678

SERVICE_NAME: Spooler
        DISPLAY_NAME: Print Spooler
        TYPE               : 110  WIN32_OWN_PROCESS  (interactive)
        STATE              : 4  RUNNING
        PID                : 2222
`;

// ── tasklist.txt for system-info-parser tests ──
export const TASKLIST_TXT = `
Image Name                     PID Session Name        Session#    Mem Usage Status          User Name                                              CPU Time Window Title                                                            
========================= ======== ================ =========== ============ =============== ================================================== ============ ========================================================================
infoservice.exe               1234 Services                   0    245,123 K Running         NT AUTHORITY\\SYSTEM                                   1:23:45 N/A                                                                     
scheduler.exe                 5678 Services                   0    112,456 K Running         NT AUTHORITY\\SYSTEM                                   0:45:12 N/A                                                                     
ae.exe                        3456 Console                    1    198,000 K Running         DOMAIN\\operator                                       0:12:34 AiraExplorer
`;

// ── EventLog for system-info-parser tests ──
export const EVENT_LOG_TXT = `2026/03/08 10:34:21 ID: 0x0000000B EventType:  1 Source: SenstarInfoService
\tString1: Service encountered an error String2: System.OutOfMemoryException
2026/03/08 09:00:00 ID: 0x00000001 EventType:  4 Source: docker
\tString1: sending event String2: module=libcontainerd namespace=moby
2026/03/08 08:30:00 ID: 0x00000005 EventType:  2 Source: SenstarScheduler
\tString1: Database connection timeout
`;

// ── Service lifecycle log content ──
export const LIFECYCLE_LOG_CONTENT = [
  '10:00:00.000       1 <BasicInf> Service\tInfoService.OnStart\tService starting',
  '10:00:01.000       1 <BasicInf> Service\tInfoService.OnStart\tService started successfully',
  '10:30:00.000       1 <Error   > Service\tInfoService.OnStop\tService stopping due to unhandled exception',
  '10:30:01.000       1 <BasicInf> Service\tInfoService.OnStop\tService stopped',
  '10:30:05.000       1 <BasicInf> Service\tInfoService.OnStart\tService starting',
  '10:30:06.000       1 <BasicInf> Service\tInfoService.OnStart\tService started successfully',
].join('\n');

// ── Cleaner (storage) log content ──
export const CLEANER_LOG_CONTENT = [
  '10:00:00.000       1 <BasicInf> Cleaner\tCleanerService.Run\tCleaner cycle started',
  '10:00:01.000       1 <BasicInf> Cleaner\tCleanerService.Run\tDisk D: usage 92% (1714.0 GB / 1863.0 GB)',
  '10:00:02.000       1 <Error   > Cleaner\tCleanerService.Run\tDisk D: FULL - free space below threshold',
  '10:00:05.000       1 <BasicInf> Cleaner\tCleanerService.Delete\tDeleted 15 files, freed 2.3 GB',
  '10:00:06.000       1 <BasicInf> Cleaner\tCleanerService.Run\tCleaner cycle complete',
].join('\n');

// ── Alarm (scac) log content ──
export const ALARM_LOG_CONTENT = [
  '10:00:00.000       1 <BasicInf> Actions\tActionManager.Execute\tAlarm triggered: Motion on Camera 5',
  '10:00:01.000       1 <BasicInf> Actions\tActionManager.Execute\tSending email notification to admin@site.com',
  '10:00:02.000       1 <Error   > Actions\tActionManager.Execute\tFailed to send email: SMTP connection refused',
  '10:00:05.000       1 <BasicInf> Actions\tActionManager.Execute\tAlarm cleared: Motion on Camera 5',
].join('\n');

// ── Network log content ──
export const NETWORK_LOG_CONTENT = [
  '10:00:00.000    1234 <BasicInf> Communication\tTcpTransport.Connect\tConnecting to 10.60.32.1:8398',
  '10:00:01.000    1234 <Error   > Communication\tTcpTransport.Connect\tConnection refused: 10.60.32.1:8398',
  '10:00:05.000    1234 <BasicInf> Communication\tTcpTransport.Connect\tConnected to 10.60.32.1:8398',
  '10:00:30.000    1234 <Error   > Communication\tTcpTransport.Send\tConnection timeout: 10.60.32.1:8398',
].join('\n');

// ── Access control log content ──
export const ACCESS_CONTROL_LOG_CONTENT = [
  '10:00:00.000       1 <BasicInf> AccessControl\tACManager.ProcessEvent\tDoor opened: Main Entrance',
  '10:00:01.000       1 <BasicInf> AccessControl\tACManager.ProcessEvent\tCredential scan: Card 12345 at Main Entrance',
  '10:00:02.000       1 <Error   > AccessControl\tACManager.Sync\tFailed to sync with panel: Connection lost',
].join('\n');

// ── Video health log content ──
export const VIDEO_LOG_CONTENT = [
  '10:00:00.000       1 <BasicInf> Tracker\tTracker.Connect\tCamera 5 connected',
  '10:00:01.000       1 <BasicInf> Tracker\tTracker.Update\tCamera 5 receiving frames at 30 fps',
  '10:00:05.000       1 <Error   > Tracker\tTracker.Update\tCamera 5 frame drop detected: 5 frames lost',
  '10:00:10.000       1 <Error   > Tracker\tTracker.Disconnect\tCamera 5 disconnected: timeout',
].join('\n');

// ── UI thread log content (AE client) ──
export const UI_THREAD_LOG_CONTENT = [
  '10:00:00.000       1 <BasicInf> UI\tWPFApplication.Run\tApplication started on thread 1',
  '10:00:00.100       1 <BasicInf> UI\tMainWindow.Initialize\tMain window created',
  '10:00:00.200       1 <BasicInf> UI\tMainWindow.Loaded\tUI layout complete',
  '10:00:05.000       1 <BasicInf> UI\tMainWindow.Update\tRefreshing camera panel',
  // 4.8 second gap — potential freeze
  '10:00:10.000       1 <BasicInf> UI\tMainWindow.Update\tPanel refresh complete',
  '10:00:10.100       1 <BasicInf> UI\tMainWindow.Update\tNormal update',
].join('\n');

// ── Auth analysis fixture (IS log with auth events) ──
export const AUTH_LOG_CONTENT = [
  '10:00:00.000    1234 <BasicInf> Security\tAuthManager.Login\tLogin successful for user operator@DOMAIN',
  '10:00:01.000    1234 <Error   > Security\tAuthManager.Login\tUser admin not authenticated by Active Directory: account locked',
  '10:00:02.000    1234 <Error   > Security\tSecureScope.Establish\tEstablishSecureScope Failed for user viewer@DOMAIN',
  '10:00:03.000    1234 <Error   > Security\tSessionManager.Create\tCreateSession Failed: token expired for user operator@DOMAIN',
  '10:00:04.000    1234 <BasicInf> Security\tAuthManager.Logout\tLogout user operator@DOMAIN session closed',
  '10:00:05.000    1234 <Error   > Security\tAuthManager.Login\tUser admin not authenticated by Active Directory: bad password',
  '10:00:06.000    1234 <Error   > Security\tCredManager.Validate\tauthentication failed for credential token expired',
].join('\n');

// ── DB health fixture (IS log with DB events) ──
export const DB_HEALTH_LOG_CONTENT = [
  '11:44:00.000    1234 <Error   > Database\tDbManager.Execute\tDbConnectionFailedException: Unable to connect to SQL Server on SQLTEST01',
  '11:44:02.000    1234 <Error   > Database\tDbManager.Execute\tDbConnectionFailedException: Unable to connect to SQL Server on SQLTEST01',
  '11:44:05.000    1234 <Error   > Database\tDbManager.Execute\tDbConnectionFailedException: Unable to connect to SQL Server on SQLTEST01',
  '11:44:10.000    1234 <Error   > Database\tDbPool.Acquire\tconnection pool exhausted: 100/100 connections in use',
  '11:44:30.000    1234 <Error   > Database\tDbManager.Execute\tSqlException: deadlock victim on table Cameras',
  '11:45:00.000    1234 <BasicInf> Database\tDbManager.Execute\tdb connection restored to SQLTEST01',
  '11:50:00.000    1234 <Error   > Database\tDbManager.Query\tcommand timeout expired for GetCameraList',
].join('\n');

// ── Inter-server fixture (IS log with inter-server comm) ──
export const INTERSERVER_LOG_CONTENT = [
  '10:00:00.000    1234 <BasicInf> Communication\tBuddyManager.Send\tSending ALIVE ---> 5001,5002,5003',
  '10:00:01.000    1234 <BasicInf> Communication\tBuddyManager.Receive\tReceived ALIVE <--- 5001',
  '10:00:02.000    1234 <BasicInf> Communication\tBuddyManager.Receive\tReceived ALIVE <--- 5002',
  '10:00:30.000    1234 <Error   > Communication\tRpcProxy.Execute\tExecuteOnProxy failed for 5003: timeout',
  '10:00:31.000    1234 <Error   > Communication\tConnectionManager.Handle\tUnable to connect to server 5003',
  '10:00:32.000    1234 <Error   > Communication\tClientManager.Process\tClientTerminated Processing of client 10.60.32.3:8398',
  '10:01:00.000    1234 <BasicInf> Communication\tBuddyManager.Send\tSendMessageToBuddies ALIVE message to 10.60.32.1:8398',
].join('\n');

// ── Hardware fixture (IS log with HW events) ──
export const HW_LOG_CONTENT = [
  '10:00:00.000    1234 <BasicInf> Hardware\tDeviceManager.Init\tAdvantech ADAM-6050 device at 10.60.31.100 initialized',
  '10:00:01.000    1234 <Error   > Hardware\tAdamDriver.Read\tReadCoil failed for Advantech device at 10.60.31.100: timeout',
  '10:00:02.000    1234 <Error   > Hardware\tSerialDriver.Open\tserial port COM3 device error: access denied',
  '10:00:03.000    1234 <Error   > Hardware\tDoorManager.Connect\tdoor controller HID connection timeout',
  '10:00:04.000    1234 <Error   > Hardware\tIOManager.Read\tIO module digital input error: device unreachable',
  '10:00:05.000    1234 <BasicInf> Hardware\tDeviceManager.Status\thardware device at 10.60.31.100 reconnected',
].join('\n');

// ── Camera fixture (tracker logs with camera events) ──
export const CAMERA_TRACKER_LOG_CONTENT = [
  '10:00:00.000       1 <BasicInf> Tracker\tTracker.Connect\tCamera 5 stream connected at 30fps',
  '10:00:10.000       1 <Error   > Tracker\tTracker.Update\tRPC Update Connection Failed for camera 12',
  '10:00:20.000       1 <Error   > Tracker\tTracker.Stream\tProblem with URL for camera configuration',
  '10:00:30.000       1 <Error   > Tracker\tTracker.Update\tframe drop detected: 3 frames lost on stream',
  '10:00:40.000       1 <Error   > Tracker\tTracker.Disconnect\tCamera 5 connection lost',
].join('\n');

// ── Camera vidcaps fixture ──
export const CAMERA_VIDCAPS_CONTENT = 'H264 1920x1080 30fps ONVIF';

// ── Isolated server fixture (sends ALIVE, receives none — one-way firewall) ──
export const ISOLATED_SERVER_LOG_CONTENT = [
  '10:00:00.000    1234 <BasicInf> Communication\tBuddyManager.Send\tSending ALIVE ---> 5001, 5020, 5022',
  '10:00:05.000    1234 <BasicInf> Communication\tBuddyManager.Send\tSending ALIVE ---> 5001, 5020, 5022',
  '10:00:10.000    1234 <BasicInf> Communication\tBuddyManager.Send\tSending ALIVE ---> 5001, 5020, 5022',
  '10:00:18.000    1234 <BasicInf> Communication\tHealthMonitor.Check\tServer 5001 ### SEEMS FAILED ###. (No ALIVE message for 18 seconds)',
  '10:00:18.500    1234 <BasicInf> Communication\tHealthMonitor.Check\tServer 5020 ### SEEMS FAILED ###. (No ALIVE message for 18 seconds)',
  '10:00:19.000    1234 <BasicInf> Communication\tHealthMonitor.Check\tServer 5022 ### SEEMS FAILED ###. (No ALIVE message for 18 seconds)',
  '10:01:00.000    1234 <BasicInf> Communication\tBuddyManager.Send\tSendMessageToBuddies ALIVE message to 10.1.100.1:5045',
  '10:01:01.000    1234 <Error   > Communication\tConnectionManager.Handle\tUnable to connect to server 5001',
  // Regular DeltaCache intervals (~5 min apart = normal)
  '10:00:00.000    1234 <BasicInf> Communication\tUpdateDeltaCache\tUpdateDeltaCache starting delta poll',
  '10:05:00.000    1234 <BasicInf> Communication\tUpdateDeltaCache\tUpdateDeltaCache starting delta poll',
  '10:10:00.000    1234 <BasicInf> Communication\tUpdateDeltaCache\tUpdateDeltaCache starting delta poll',
  '10:15:00.000    1234 <BasicInf> Communication\tUpdateDeltaCache\tUpdateDeltaCache starting delta poll',
  // Abnormal gap: 30 min (6× the 5-min median → exceeds 2× threshold)
  '10:45:00.000    1234 <BasicInf> Communication\tUpdateDeltaCache\tUpdateDeltaCache starting delta poll',
  '10:50:00.000    1234 <BasicInf> Communication\tUpdateDeltaCache\tUpdateDeltaCache starting delta poll',
].join('\n');

// ── Healthy farm member fixture (normal bidirectional ALIVE exchange) ──
export const HEALTHY_FARM_LOG_CONTENT = [
  '10:00:00.000    1234 <BasicInf> Communication\tBuddyManager.Send\tSending ALIVE ---> 5020, 5022, 5023',
  '10:00:01.000    1234 <BasicInf> Communication\tBuddyManager.Receive\tReceived ALIVE <--- 5020',
  '10:00:02.000    1234 <BasicInf> Communication\tBuddyManager.Receive\tReceived ALIVE <--- 5022',
  '10:00:03.000    1234 <BasicInf> Communication\tBuddyManager.Receive\tReceived ALIVE <--- 5023',
  '10:00:04.000    1234 <BasicInf> Communication\tDeviceGraph.Push\tForceServerRefreshDeviceGraph received from master',
  '10:00:05.000    1234 <BasicInf> Communication\tUpdateDeltaCache\tUpdateDeltaCache starting delta poll',
  '10:00:35.000    1234 <BasicInf> Communication\tUpdateDeltaCache\tUpdateDeltaCache starting delta poll',
  '10:01:05.000    1234 <BasicInf> Communication\tUpdateDeltaCache\tUpdateDeltaCache starting delta poll',
  '10:00:06.000    1234 <BasicInf> Communication\tBuddyManager.Send\tSendMessageToBuddies ALIVE message to 10.14.100.1:5045',
  '10:00:07.000    1234 <BasicInf> Communication\tServerInfo.Log\tServer 5020 at IP 10.14.100.1 is healthy',
].join('\n');

// ── DownServer RPC fixture (server reporting peers as down) ──
export const DOWN_SERVER_RPC_CONTENT = [
  '10:00:00.000    1234 <BasicInf> Communication\tBuddyManager.Send\tSending ALIVE ---> 5001, 5003',
  '10:00:01.000    1234 <BasicInf> Communication\tBuddyManager.Receive\tReceived ALIVE <--- 5001',
  '10:00:05.000    1234 <BasicInf> Communication\tUpdateDeltaCache\tUpdateDeltaCache starting delta poll',
  '10:00:10.000    1234 <Verbose > Communication\tSignals.DownServer\tCalling 5003 signals.DownServer for down server 5001',
  '10:00:11.000    1234 <Verbose > Communication\tSignals.DownServer\tCalling 5003 signals.DownServer for down server 5001',
  '10:00:15.000    1234 <BasicInf> Communication\tSignals.Verify\t5015 says 5018 is down',
  '10:00:20.000    1234 <Verbose > Communication\tSignals.DownServer\tCalling 5003 signals.DownServer for down server 5007',
  '10:00:35.000    1234 <BasicInf> Communication\tUpdateDeltaCache\tUpdateDeltaCache starting delta poll',
  '10:01:05.000    1234 <BasicInf> Communication\tUpdateDeltaCache\tUpdateDeltaCache starting delta poll',
].join('\n');

// ── Master changeover fixture (master server switchover event) ──
export const MASTER_CHANGEOVER_CONTENT = [
  '10:00:00.000    1234 <BasicInf> Communication\tBuddyManager.Send\tSending ALIVE ---> 5001, 5003',
  '10:00:01.000    1234 <BasicInf> Communication\tBuddyManager.Receive\tReceived ALIVE <--- 5001',
  '10:00:05.000    1234 <BasicInf> Communication\tUpdateDeltaCache\tUpdateDeltaCache starting delta poll',
  '10:00:35.000    1234 <BasicInf> Communication\tUpdateDeltaCache\tUpdateDeltaCache starting delta poll',
  '10:01:05.000    1234 <BasicInf> Communication\tUpdateDeltaCache\tUpdateDeltaCache starting delta poll',
  '10:59:38.000    1234 <BasicInf> Communication\tFarmManager.Update\tChanging master server from <5001> to <5003>',
  '11:00:01.000    1234 <BasicInf> Communication\tBuddyManager.Receive\tReceived ALIVE <--- 5003',
].join('\n');

// ── Interserver map fixture with multiple client ports per IP ──
export const INTERSERVER_MAP_NOISE_CONTENT = [
  '10:00:00.000    1234 <BasicInf> Communication\tBuddyManager.Send\tSending ALIVE ---> 5022, 5023',
  '10:00:01.000    1234 <BasicInf> Communication\tBuddyManager.Send\tSendMessageToBuddies ALIVE message to 10.1.100.1:5045',
  '10:00:02.000    1234 <Error   > Communication\tClientManager.Process\tClientTerminated Processing of client 10.1.100.1:6691',
  '10:00:03.000    1234 <Error   > Communication\tClientManager.Process\tClientTerminated Processing of client 10.1.100.1:6815',
  '10:00:04.000    1234 <Error   > Communication\tClientManager.Process\tClientTerminated Processing of client 10.1.100.1:8000',
  '10:00:05.000    1234 <Error   > Communication\tClientManager.Process\tClientTerminated Processing of client 10.2.100.1:52892',
  '10:00:06.000    1234 <Error   > Communication\tClientManager.Process\tClientTerminated Processing of client 10.2.100.1:53111',
  '10:00:07.000    1234 <Error   > Communication\tConnectionManager.Handle\tUnable to connect to server 5023',
].join('\n');

// ── SSL certificate issues fixture ──
export const SSL_ISSUES_CONTENT = [
  '10:00:00.000    1234 <BasicInf> Communication\tBuddyManager.Send\tSending ALIVE ---> 5020',
  '10:00:01.000    1234 <BasicInf> Communication\tBuddyManager.Receive\tReceived ALIVE <--- 5020',
  '10:00:02.000    1234 <MoreInfo> Communication\tMessageDispatcher.ValidateServerCertificate\tSSL policy: RemoteCertificateNotAvailable',
  '10:00:03.000    1234 <MoreInfo> Communication\tMessageDispatcher.ValidateServerCertificate\tSSL policy: RemoteCertificateNotAvailable',
  '10:00:04.000    1234 <MoreInfo> Communication\tMessageDispatcher.ValidateServerCertificate\tSSL policy: RemoteCertificateChainErrors',
  '10:00:05.000    1234 <BasicInf> Communication\tUpdateDeltaCache\tUpdateDeltaCache starting delta poll',
  '10:00:35.000    1234 <BasicInf> Communication\tUpdateDeltaCache\tUpdateDeltaCache starting delta poll',
  '10:01:05.000    1234 <BasicInf> Communication\tUpdateDeltaCache\tUpdateDeltaCache starting delta poll',
].join('\n');

// ── BACK UP recovery + No message dispatcher fixture ──
export const RECOVERY_AND_OVERLOAD_CONTENT = [
  '10:00:00.000    1234 <BasicInf> Communication\tBuddyManager.Send\tSending ALIVE ---> 5031',
  '10:00:01.000    1234 <BasicInf> Communication\tBuddyManager.Receive\tReceived ALIVE <--- 5031',
  '10:00:05.000    1234 <BasicInf> Communication\tUpdateDeltaCache\tUpdateDeltaCache starting delta poll',
  '10:00:30.000    1234 <BasicInf> Communication\tHealthMonitor.Check\tServer 5031 ### SEEMS FAILED ###. (No ALIVE message for 30 seconds)',
  '10:00:35.000    1234 <BasicInf> Communication\tUpdateDeltaCache\tUpdateDeltaCache starting delta poll',
  '10:01:05.000    1234 <BasicInf> Communication\tUpdateDeltaCache\tUpdateDeltaCache starting delta poll',
  '10:01:22.000    1234 <BasicInf> Communication\tHealthMonitor.Check\tServer 5031 ### BACK UP ###. Setting his state to Up.',
  '10:01:30.000    1234 <Error   > Communication\tWebServiceExchange\tNo message dispatcher/pool available to route WebServiceMessageExchange request(s) to.',
  '10:01:31.000    1234 <Error   > Communication\tWebServiceExchange\tNo message dispatcher/pool available to route WebServiceMessageExchange request(s) to.',
  '10:01:32.000    1234 <Error   > Communication\tWebServiceExchange\tNo message dispatcher/pool available to route WebServiceMessageExchange request(s) to.',
].join('\n');

export const SERVICE_RESTART_CAUSE_CONTENT = [
  '12:54:14.550    3496 <BasicInf> WebService\tInfoService.InfoService.OnStop[5019 InfoService.exe]\tReceived request to stop InfoService',
  '12:54:14.553    3496 <BasicInf> Cloud\tInfoServiceCloudProxyHeartbeat.HeartbeatLoop\tclean shutdown',
  '12:54:14.557    3496 <BasicInf> ACL\tAccessControlManager\tStopping access control',
  '12:54:14.978    3496 <BasicInf> WebService\tInfoService.InfoService.OnStop[5019 InfoService.exe]\tComplete',
].join('\n');

export const PENDING_CHANGES_TIMEOUT_CONTENT = [
  '12:57:32.165   36868 <Error   > Device\tCDeviceManager.WaitForPendingChanges | TimeoutException after waiting 00:02:00.0021625 for pending changes',
  '12:57:32.179   30560 <Error   > Device\tRequestLogger\tPUT https://wtf1/api/cameras exceptionGuid=4c647027 System.TimeoutException: Waiting for pending changes',
  '13:06:13.341   36868 <Error   > Device\tCDeviceManager.WaitForPendingChanges | TimeoutException after waiting 00:02:00.0027090 for pending changes',
].join('\n');

export const ADDRESS_CONFIG_ERROR_CONTENT = [
  '12:58:10.021    8984 <Error   > Reports\tScheduledReports\tError getting address for id 5002: System.FormatException: Null or blank address',
  '12:58:10.025    8984 <Error   > Reports\tScheduledReports\tError getting address for id 5002: System.FormatException: Null or blank address',
  '12:58:10.025    8984 <Error   > Reports\tScheduledReports\tError getting FQDN for id 5002: Seer.Exceptions.RetrieveAddressException: Error getting address for id 5002 ---> System.FormatException: Null or blank address',
  '12:59:10.004   14164 <Error   > Reports\tScheduledReports\tError getting address for id 5003: System.FormatException: Null or blank address',
].join('\n');

// ── Crash dump + unhandled exception fixture (AE client crash) ──
export const CRASH_DUMP_CONTENT = [
  '03:00:00.000       1 <BasicInf> UI\tMainWindow.Update\tNormal operation',
  '03:00:05.000       1 <Error   > System\tApplication_ThreadException\tSystem.NullReferenceException: Object reference not set to an instance of an object.',
  '   at Seer.UI.AlarmPanel.OnTimer()',
  '03:00:05.100       1 <Error   > System\tMyUnhandledExceptionHandlerTerminator\tFatal: writing dump before exit',
  '03:00:05.200       1 <BasicInf> System\tDumpWriter\tSaved minidump to C:\\ProgramData\\Senstar\\dumps\\ae_030005.dmp',
  '03:00:05.300       1 <BasicInf> System\tDumpWriter\tSaved minidump to C:\\ProgramData\\Senstar\\dumps\\ae_030005_full.dmp',
].join('\n');

// ── DNS resolution failure fixture (AE client can't reach servers) ──
export const DNS_FAILURE_CONTENT = [
  '10:00:00.000    1234 <BasicInf> Communication\tConnectionManager.Connect\tConnecting to NODE1',
  "10:00:01.000    1234 <Error   > Communication\tConnectionManager.Connect\tUnable to resolve server address 'NODE1.corp.local'",
  "10:00:02.000    1234 <Error   > Communication\tConnectionManager.Connect\tUnable to resolve server address 'NODE2.corp.local'",
  "10:00:03.000    1234 <Error   > Communication\tConnectionManager.Connect\tUnable to resolve server address 'NODE1.corp.local'",
  "10:00:04.000    1234 <Error   > Communication\tConnectionManager.Connect\tUnable to resolve server address 'NODE2.corp.local'",
  "10:00:05.000    1234 <Error   > Communication\tConnectionManager.Connect\tUnable to resolve server address 'NODE1.corp.local'",
].join('\n');

// ── Session/token failure fixture (IS log with auth session issues) ──
export const SESSION_FAILURE_CONTENT = [
  '10:00:00.000    1234 <Error   > Security\tSessionManager.Validate\tTokenNotFoundException: Session token not found in store',
  '10:00:01.000    1234 <Error   > Security\tSessionManager.Validate\tTokenNotFoundException: Session token not found in store',
  '10:00:02.000    1234 <Error   > Security\tSessionManager.Validate\tSeer.Exceptions.InvalidSessionException: Session expired',
  '10:00:03.000    1234 <Error   > Security\tSessionManager.Validate\tTokenNotFoundException: Session token not found in store',
  '10:00:04.000    1234 <Error   > Security\tSessionManager.Validate\tInvalidSessionID: No matching session',
].join('\n');

// ── Request delivery failure fixture (AE client delivery issues) ──
export const DELIVERY_FAILURE_CONTENT = [
  '10:00:00.000    1234 <Error   > Communication\tMessageRouter.Send\tRequestFailedDelivery for FeatureExists to server 5001',
  '10:00:01.000    1234 <Error   > Communication\tMessageRouter.Send\tRequestFailedDelivery for GetVideoWallModel to server 5001',
  '10:00:02.000    1234 <Error   > Communication\tMessageRouter.Send\tCould not retrieve result for ServerConfigPort from server 5001',
  '10:00:03.000    1234 <Error   > Communication\tMessageRouter.Send\tRequestFailedDelivery for GetCameraList to server 5000',
].join('\n');

// ── IS log with FULL diagnostic log level ──
export const IS_FULL_LOG_LEVEL_CONTENT = [
  '11:44:24.451   32716 <BasicInf> Logging level changed to: BasicInfo|LogError',
  '11:44:29.987   31532 <BasicInf> Logging level changed to: BasicInfo|LogError|MoreInfo|LogDiagnostic|Verbose',
  '11:45:00.000   31532 <Diagnost> Communication\tMessageDispatcher\tDetailed diagnostic info here',
  '11:45:01.000   31532 <MoreInfo> Service\tInfoService.OnStart\tLoading configuration',
  '11:45:02.000   31532 <Verbose > LicenseParser\tLoadXml\tParsing license file',
].join('\n');

// ── IS log with MINIMAL log level (BasicInfo|LogError only) ──
export const IS_MINIMAL_LOG_LEVEL_CONTENT = [
  '11:47:27.462    6512 <BasicInf> Logging level changed to: BasicInfo|LogError',
  '11:47:28.000    6512 <BasicInf> Service\tInfoService.OnStart\tService starting',
  '11:47:29.000    6512 <Error   > WebService\tHandler.Execute\tSystem.TimeoutException',
  '11:47:30.000    6512 <BasicInf> Service\tInfoService.OnStart\tService started successfully',
].join('\n');

// ── AE log with MINIMAL log level ──
export const AE_MINIMAL_LOG_LEVEL_CONTENT = [
  '09:37:52.686   29984 <BasicInf> Logging level changed to: BasicInfo|LogError',
  '09:37:53.000   29984 <BasicInf> Client settings were not found in registry, using defaults',
  '09:38:00.000   29984 <Error   > Communication\tConnectionManager.Connect\tConnection refused: 10.60.32.1:8398',
].join('\n');

// ── IS log with UpdateServerLogLevel and UpdateCameraLogLevel ──
export const SERVER_CAMERA_LOG_LEVEL_CONTENT = [
  '12:05:55.902    7524 <BasicInf> Logging level changed to: BasicInfo|LogError|MoreInfo|LogDiagnostic|Verbose',
  "12:05:55.902    7524 <BasicInf> WebService\tLogSettings\tUpdateServerLogLevel | Updating logging level for InfoService to: 'BasicInfo|LogError|MoreInfo|LogDiagnostic|Verbose|LogPolicies'",
  "12:05:55.902    7524 <BasicInf> WebService\tLogSettings\tUpdateServerLogLevel | Updating logging level for Scheduler to: 'BasicInfo|LogError'",
  "12:17:48.967   10040 <BasicInf> WebService\tLogSettings\tUpdateCameraLogLevel | Updating logging level for camera 1 to: 'BasicInfo|LogError|MoreInfo|Verbose|LogDiagnostic|LogPolicies'",
  "12:24:17.634    1040 <BasicInf> WebService\tLogSettings\tUpdateCameraLogLevel | Updating logging level for camera 2 to: 'BasicInfo|LogError|MoreInfo|Verbose|LogDiagnostic|LogPolicies'",
].join('\n');

