fn main() {
    let home = std::env::var("HOME").unwrap_or_default();
    println!("HOME={home}");
    match procmix_lib::core::assistant::provider::load_codex_cli_settings() {
        Ok(settings) => println!("OK base={} responses={} catalog={} key={}", settings.base_url, settings.use_responses_api, settings.catalog_path.display(), settings.api_key.is_some()),
        Err(error) => println!("ERR={error:?}"),
    }
}
