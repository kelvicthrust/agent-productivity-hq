# Historical delivery handoff

The delivery package captured local setup and recovery instructions, a candidate evidence map
and outstanding findings. Independent Verification requested changes, and Code Review reported
changes required. The assessment applied to the historical candidate. See the current
[setup guide](../../delivery/setup.md) and [check commands](../../../README.md#checks).

## Remaining limits and responsible owners

- **Paseo and transcript attribution:** live daemon compatibility, provider identity joins
  and real transcript attribution were unverified. Implementation needs real-source evidence
  for independent assessment.
- **Startup and coordination:** first launch through a real listener, browser completion of Setup,
  and real instance coordination remained open. In-process Setup checks covered a narrower path.
- **Appearance and status wording:** Delivery evidence cards, notification placement and shape,
  recovery styling and Paseo helper text remained unreconciled. Sources could claim it retained a
  previous snapshot when none existed.
- **Account reports and sign-in:** overall ChatGPT report scope was deferred. The historical minimum-
  permission GitHub App check failed and was waived for broader existing grants. The live Claude
  step remained optional under the fixture and documentation exception. Real supported sign-in reuse
  and native Keychain-only storage were partially assessed.
- **Security and accessibility:** live outgoing-network and real-socket observations, manual
  VoiceOver and assistive-technology evidence were missing. Review used its general security
  method. A settings-edit concurrency concern and a development-only dependency advisory were
  recorded.
- **Performance:** the 16 ms ceiling and raw maximum verdicts retained historical misses.
  Native-browser and owner-hardware timing were unmeasured.

The [build record](build-record.md), [candidate map](../implementation/candidate-handoff.md),
and [execution record](../implementation/execution-record.md) provide scope and supporting evidence.
