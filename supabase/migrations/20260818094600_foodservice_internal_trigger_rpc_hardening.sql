revoke all on function public.fn_food_cancel_recovery_on_order_created() from public,anon,authenticated;
grant execute on function public.fn_food_cancel_recovery_on_order_created() to service_role;

revoke all on function public.fn_food_demo_manage_silence_followup() from public,anon,authenticated;
grant execute on function public.fn_food_demo_manage_silence_followup() to service_role;

revoke all on function public.fn_food_demo_schedule_cart_recovery() from public,anon,authenticated;
grant execute on function public.fn_food_demo_schedule_cart_recovery() to service_role;

revoke all on function public.fn_food_demo_schedule_manual_flow_fallback() from public,anon,authenticated;
grant execute on function public.fn_food_demo_schedule_manual_flow_fallback() to service_role;

revoke all on function public.fn_enable_food_demo_commercial_flows_on_working_session() from public,anon,authenticated;
grant execute on function public.fn_enable_food_demo_commercial_flows_on_working_session() to service_role;